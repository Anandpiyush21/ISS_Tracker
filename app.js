/**
 * ISS Tracker
 * -----------
 * Plots the live position of the International Space Station on an OpenLayers
 * map, together with its ground track, its visibility footprint and the solar
 * terminator. Telemetry comes from the "Where the ISS at?" REST API.
 *
 * No build step, no dependencies beyond the OpenLayers bundle loaded in
 * index.html. Everything lives inside one IIFE to keep the global scope clean.
 */
(function () {
  "use strict";

  /* ===========================================================
     Configuration
     =========================================================== */

  var API = "https://api.wheretheiss.at/v1/satellites/25544";
  var POLL_MS = 2000; // the public API is rate limited to ~1 request/second
  var STALE_MS = 15000; // no fresh sample for this long => flag the feed
  var MAX_BACKOFF_MS = 30000;

  var TRAIL_MAX_POINTS = 900; // ~30 min of history at POLL_MS
  var ORBIT_MINUTES = 93; // one ISS revolution
  var ORBIT_SAMPLES = 30; // predicted points, fetched 10 at a time
  var ORBIT_REFRESH_MS = 90000;

  var EARTH_RADIUS_KM = 6371;
  var KM_PER_MILE = 1.609344;

  var STORAGE_KEY = "iss-tracker.prefs";

  /* ===========================================================
     Small helpers
     =========================================================== */

  var $ = function (id) {
    return document.getElementById(id);
  };

  var rad = function (deg) {
    return (deg * Math.PI) / 180;
  };
  var deg = function (r) {
    return (r * 180) / Math.PI;
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Normalises a longitude back into [-180, 180). */
  function wrapLon(lon) {
    return ((((lon + 180) % 360) + 360) % 360) - 180;
  }

  /** Shortest signed difference between two longitudes, in degrees. */
  function lonDelta(from, to) {
    var d = ((to - from + 540) % 360) - 180;
    return d;
  }

  /** Great-circle distance along the surface, in kilometres. */
  function groundDistanceKm(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Straight-line distance from a point on the ground to the station. */
  function slantRangeKm(observer, iss) {
    var theta = groundDistanceKm(observer, iss) / EARTH_RADIUS_KM;
    var r = EARTH_RADIUS_KM;
    var R = EARTH_RADIUS_KM + iss.alt;
    return Math.sqrt(r * r + R * R - 2 * r * R * Math.cos(theta));
  }

  /** Radius of the circle on the ground from which the ISS is above the horizon. */
  function footprintRadiusKm(altitudeKm) {
    return EARTH_RADIUS_KM * Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm));
  }

  /** Point at `distanceKm` from `origin` along `bearingDeg` (spherical Earth). */
  function destination(origin, distanceKm, bearingDeg) {
    var d = distanceKm / EARTH_RADIUS_KM;
    var br = rad(bearingDeg);
    var lat1 = rad(origin.lat);
    var lon1 = rad(origin.lon);
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
    var lon2 =
      lon1 +
      Math.atan2(
        Math.sin(br) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );
    return { lat: deg(lat2), lon: deg(lon2) };
  }

  /* ---------- formatting ---------- */

  function toDMS(value, positive, negative) {
    var abs = Math.abs(value);
    var d = Math.floor(abs);
    var m = Math.floor((abs - d) * 60);
    var s = ((abs - d) * 60 - m) * 60;
    return d + "° " + m + "' " + s.toFixed(1) + '" ' + (value >= 0 ? positive : negative);
  }

  function formatSigned(value, suffixPos, suffixNeg) {
    return Math.abs(value).toFixed(4) + "° " + (value >= 0 ? suffixPos : suffixNeg);
  }

  function formatTime(date, timeZone) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: timeZone,
    }).format(date);
  }

  /* ---------- preferences ---------- */

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) {
      /* storage may be unavailable (private mode); preferences are optional */
    }
  }

  /* ===========================================================
     Solar terminator
     -----------------------------------------------------------
     Builds the polygon covering the half of the globe that is
     currently in darkness, from the Sun's apparent position.
     =========================================================== */

  var Terminator = {
    julianDay: function (date) {
      return date.getTime() / 86400000 + 2440587.5;
    },

    /** Greenwich mean sidereal time, in hours. */
    gmst: function (jd) {
      var d = jd - 2451545.0;
      return (18.697374558 + 24.06570982441908 * d) % 24;
    },

    /** Apparent right ascension and declination of the Sun, in degrees. */
    sunPosition: function (jd) {
      var n = jd - 2451545.0;
      var L = 280.46 + 0.9856474 * n; // mean longitude
      var g = rad(357.528 + 0.9856003 * n); // mean anomaly
      var lambda = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)); // ecliptic longitude
      var epsilon = rad(23.4393 - 0.0000004 * n); // obliquity of the ecliptic

      var alpha = deg(Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)));
      var delta = deg(Math.asin(Math.sin(epsilon) * Math.sin(lambda)));
      return { alpha: alpha, delta: delta };
    },

    /**
     * Ring of [lon, lat] pairs enclosing the night side, ready to be turned
     * into a polygon. Returns null while the Sun sits exactly on the equator
     * (the degenerate case where the terminator is a meridian pair).
     */
    nightRing: function (date) {
      var jd = Terminator.julianDay(date);
      var sun = Terminator.sunPosition(jd);
      var gst = Terminator.gmst(jd);
      var tanDelta = Math.tan(rad(sun.delta));
      if (Math.abs(tanDelta) < 1e-6) return null;

      var ring = [];
      for (var lon = -180; lon <= 180; lon += 1) {
        var hourAngle = rad(gst * 15 + lon - sun.alpha);
        var lat = deg(Math.atan(-Math.cos(hourAngle) / tanDelta));
        ring.push([lon, clamp(lat, -85, 85)]);
      }

      // Close the ring along whichever pole is currently in darkness.
      var pole = sun.delta > 0 ? -85 : 85;
      ring.push([180, pole], [-180, pole]);
      return ring;
    },
  };

  /* ===========================================================
     Map
     =========================================================== */

  var ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  var ESRI_CREDIT = "Tiles &copy; Esri";

  function esriSource(service, maxZoom, attribution) {
    return new ol.source.XYZ({
      url: ESRI + service + "/MapServer/tile/{z}/{y}/{x}",
      attributions: attribution,
      maxZoom: maxZoom,
      crossOrigin: "anonymous",
    });
  }

  /**
   * Two basemaps, both key-free. "dark" is a muted canvas that keeps the
   * orbit lines legible; "satellite" swaps in true-colour imagery. `nextLabel`
   * is what the toggle button offers while that basemap is active.
   */
  var BASEMAPS = {
    dark: {
      nextLabel: "Satellite",
      base: function () {
        return esriSource(
          "Canvas/World_Dark_Gray_Base",
          16,
          ESRI_CREDIT + ", HERE, Garmin, &copy; OpenStreetMap contributors"
        );
      },
      // Place names live in a separate service, drawn above the orbit overlays.
      labels: function () {
        return esriSource("Canvas/World_Dark_Gray_Reference", 16, "");
      },
    },
    satellite: {
      nextLabel: "Dark map",
      base: function () {
        return esriSource(
          "World_Imagery",
          18,
          ESRI_CREDIT + ", Maxar, Earthstar Geographics"
        );
      },
      labels: null,
    },
  };

  var STYLES = {
    trail: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "rgba(90, 209, 255, 0.85)", width: 2.5 }),
    }),
    orbit: new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "rgba(255, 179, 71, 0.75)",
        width: 2,
        lineDash: [6, 7],
      }),
    }),
    footprint: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "rgba(90, 209, 255, 0.55)", width: 1.5 }),
      fill: new ol.style.Fill({ color: "rgba(90, 209, 255, 0.08)" }),
    }),
    night: new ol.style.Style({
      fill: new ol.style.Fill({ color: "rgba(2, 4, 12, 0.55)" }),
      stroke: new ol.style.Stroke({ color: "rgba(255, 206, 120, 0.55)", width: 1.25 }),
    }),
    observer: new ol.style.Style({
      image: new ol.style.Circle({
        radius: 5,
        fill: new ol.style.Fill({ color: "#57d9a3" }),
        stroke: new ol.style.Stroke({ color: "rgba(5, 7, 15, 0.9)", width: 2 }),
      }),
    }),
    // The station marker is a soft halo with the station artwork on top, so
    // it stays findable against both the dark canvas and satellite imagery.
    iss: [
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 16,
          fill: new ol.style.Fill({ color: "rgba(90, 209, 255, 0.16)" }),
          stroke: new ol.style.Stroke({ color: "rgba(90, 209, 255, 0.45)", width: 1 }),
        }),
      }),
      new ol.style.Style({
        image: new ol.style.Icon({
          src: "iss.png",
          anchor: [0.5, 0.5],
          scale: 0.42,
        }),
      }),
    ],
  };

  var map, baseLayer, labelLayer, features, layers;
  var currentBasemap = "dark";

  function buildMap() {
    baseLayer = new ol.layer.Tile({ source: BASEMAPS[currentBasemap].base(), zIndex: 0 });
    labelLayer = new ol.layer.Tile({ zIndex: 3, opacity: 0.8 });

    features = {
      night: new ol.Feature(),
      footprint: new ol.Feature(),
      trail: new ol.Feature(),
      orbit: new ol.Feature(),
      iss: new ol.Feature(),
      observer: new ol.Feature(),
    };

    features.night.setStyle(STYLES.night);
    features.footprint.setStyle(STYLES.footprint);
    features.trail.setStyle(STYLES.trail);
    features.orbit.setStyle(STYLES.orbit);
    features.iss.setStyle(STYLES.iss);
    features.observer.setStyle(STYLES.observer);

    function vector(feature, zIndex) {
      return new ol.layer.Vector({
        source: new ol.source.Vector({ features: [feature] }),
        zIndex: zIndex,
      });
    }

    // Draw order, bottom to top: shading, footprint, place names, orbit
    // lines, then the markers. Place names sit under the lines so the track
    // is never broken up by labels, and over the shading so they stay legible.
    layers = {
      night: vector(features.night, 1),
      footprint: vector(features.footprint, 2),
      orbit: vector(features.orbit, 4),
      trail: vector(features.trail, 5),
      observer: vector(features.observer, 6),
      iss: vector(features.iss, 7),
    };

    map = new ol.Map({
      target: "map",
      layers: [
        baseLayer,
        labelLayer,
        layers.night,
        layers.footprint,
        layers.orbit,
        layers.trail,
        layers.observer,
        layers.iss,
      ],
      view: new ol.View({
        center: ol.proj.fromLonLat([0, 20]),
        zoom: 3,
        minZoom: 2,
        maxZoom: 12,
      }),
      controls: ol.control.defaults.defaults({ rotate: false }),
    });

    // Panning the map by hand turns following off, so the view stays put.
    if (BASEMAPS[currentBasemap].labels) {
      labelLayer.setSource(BASEMAPS[currentBasemap].labels());
    }

    map.on("pointerdrag", function () {
      if (state.follow) setFollow(false);
    });
  }

  function setBasemap(key) {
    currentBasemap = key;
    baseLayer.setSource(BASEMAPS[key].base());
    labelLayer.setSource(BASEMAPS[key].labels ? BASEMAPS[key].labels() : null);
  }

  /* ===========================================================
     Geometry updates
     =========================================================== */

  /**
   * Projects [lon, lat] pairs, unwrapping longitudes so a line never whips
   * across the map at the antimeridian.
   *
   * `anchorIndex` is the point whose longitude is left untouched; the rest are
   * walked outwards from it. That matters because the station marker is always
   * drawn at its raw longitude, so whichever end of a path meets the marker has
   * to be the anchor — otherwise the two drift a full world apart once the
   * station crosses 180°.
   */
  function projectPath(points, anchorIndex) {
    var anchor = anchorIndex || 0;
    var lons = new Array(points.length);
    var i;

    lons[anchor] = points[anchor][0];
    for (i = anchor + 1; i < points.length; i++) {
      lons[i] = lons[i - 1] + lonDelta(points[i - 1][0], points[i][0]);
    }
    for (i = anchor - 1; i >= 0; i--) {
      lons[i] = lons[i + 1] - lonDelta(points[i][0], points[i + 1][0]);
    }

    return points.map(function (point, index) {
      return ol.proj.fromLonLat([lons[index], point[1]]);
    });
  }

  function drawTrail() {
    if (state.trail.length < 2) {
      features.trail.setGeometry(null);
      return;
    }
    // Anchored at the newest sample, which is where the marker sits.
    features.trail.setGeometry(
      new ol.geom.LineString(projectPath(state.trail, state.trail.length - 1))
    );
  }

  /**
   * Draws the predicted track from the station's current position onwards.
   * Points the station has already flown past are dropped, and the live
   * position is prepended, so the dashed line always starts at the marker.
   */
  function drawOrbit() {
    var now = Date.now() / 1000;
    var ahead = state.orbit.filter(function (point) {
      return point.t > now;
    });

    if (!ahead.length || !state.latest) {
      features.orbit.setGeometry(null);
      return;
    }

    var points = [[state.latest.lon, state.latest.lat]].concat(
      ahead.map(function (point) {
        return [point.lon, point.lat];
      })
    );
    // Index 0 is the live position, so the default anchor is already correct.
    features.orbit.setGeometry(new ol.geom.LineString(projectPath(points)));
  }

  function drawFootprint(position) {
    var radius = position.footprint;
    var ring = [];
    var previousLon = position.lon;
    var unwrapped = position.lon;

    for (var bearing = 0; bearing <= 360; bearing += 4) {
      var p = destination(position, radius, bearing);
      unwrapped += lonDelta(previousLon, p.lon);
      previousLon = p.lon;
      ring.push(ol.proj.fromLonLat([unwrapped, p.lat]));
    }
    features.footprint.setGeometry(new ol.geom.Polygon([ring]));
  }

  function drawNight() {
    var ring = Terminator.nightRing(new Date());
    if (!ring) {
      features.night.setGeometry(null);
      return;
    }
    var coords = ring.map(function (p) {
      return ol.proj.fromLonLat(p);
    });
    features.night.setGeometry(new ol.geom.Polygon([coords]));
  }

  /* ===========================================================
     Marker animation
     -----------------------------------------------------------
     Samples arrive every couple of seconds; the marker glides
     between them so the station never teleports.
     =========================================================== */

  var animation = null;

  function moveMarker(target, duration) {
    var from = state.rendered;
    if (!from || duration <= 0) {
      state.rendered = { lon: target.lon, lat: target.lat };
      commitMarker();
      return;
    }

    var start = performance.now();
    var startLon = from.lon;
    var startLat = from.lat;
    var dLon = lonDelta(from.lon, target.lon);
    var dLat = target.lat - from.lat;

    if (animation) cancelAnimationFrame(animation);

    (function step(now) {
      var t = clamp((now - start) / duration, 0, 1);
      // Interpolating along the shortest arc can run past ±180, so the result
      // is wrapped back into range. The marker, the trail and the map centre
      // then all live in the same coordinate space, and OpenLayers keeps the
      // view inside the world extent.
      state.rendered = { lon: wrapLon(startLon + dLon * t), lat: startLat + dLat * t };
      commitMarker();
      if (t < 1) animation = requestAnimationFrame(step);
    })(start);
  }

  function commitMarker() {
    var p = state.rendered;
    features.iss.setGeometry(new ol.geom.Point(ol.proj.fromLonLat([p.lon, p.lat])));
    if (state.follow) {
      map.getView().setCenter(ol.proj.fromLonLat([p.lon, p.lat]));
    }
  }

  /* ===========================================================
     Telemetry feed
     =========================================================== */

  var state = {
    follow: true,
    showTrail: true,
    showNight: true,
    units: "metric",
    trail: [],
    orbit: [],
    rendered: null,
    latest: null,
    observer: null,
    lastSuccess: 0,
    backoff: 0,
  };

  function request(url) {
    return fetch(url, { cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function poll() {
    request(API + "?units=kilometers")
      .then(function (data) {
        state.backoff = 0;
        state.lastSuccess = Date.now();
        onSample({
          lat: data.latitude,
          lon: data.longitude,
          alt: data.altitude,
          velocity: data.velocity,
          visibility: data.visibility,
          timestamp: data.timestamp,
          // The API reports the footprint as a diameter; fall back to our own
          // horizon calculation if the field is ever missing.
          footprint: data.footprint ? data.footprint / 2 : footprintRadiusKm(data.altitude),
        });
        schedule(POLL_MS);
      })
      .catch(function (error) {
        console.warn("ISS telemetry request failed:", error.message);
        state.backoff = state.backoff ? Math.min(state.backoff * 2, MAX_BACKOFF_MS) : POLL_MS * 2;
        setStatus("error", "Reconnecting…");
        schedule(state.backoff);
      });
  }

  var pollTimer = null;
  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function onSample(position) {
    state.latest = position;

    var last = state.trail[state.trail.length - 1];
    if (!last || Math.abs(last[0] - position.lon) > 1e-6 || Math.abs(last[1] - position.lat) > 1e-6) {
      state.trail.push([position.lon, position.lat]);
      if (state.trail.length > TRAIL_MAX_POINTS) state.trail.shift();
    }

    drawTrail();
    drawOrbit();
    drawFootprint(position);
    moveMarker(position, state.rendered ? POLL_MS : 0);
    render(position);
  }

  /** Fetches the predicted ground track for the next orbit, 10 points per call. */
  function refreshOrbit() {
    var now = Math.floor(Date.now() / 1000);
    var stepSeconds = Math.round((ORBIT_MINUTES * 60) / ORBIT_SAMPLES);
    var batches = [];

    for (var i = 0; i < ORBIT_SAMPLES; i += 10) {
      var stamps = [];
      for (var j = i; j < Math.min(i + 10, ORBIT_SAMPLES); j++) {
        stamps.push(now + j * stepSeconds);
      }
      batches.push(stamps);
    }

    // Serialised with a gap between calls to stay inside the API's rate limit.
    var collected = [];
    var chain = Promise.resolve();
    batches.forEach(function (stamps, index) {
      chain = chain
        .then(function () {
          return index === 0 ? null : new Promise(function (r) { setTimeout(r, 1200); });
        })
        .then(function () {
          return request(API + "/positions?timestamps=" + stamps.join(",") + "&units=kilometers");
        })
        .then(function (rows) {
          rows.forEach(function (row) {
            collected.push({ t: row.timestamp, lon: row.longitude, lat: row.latitude });
          });
        });
    });

    chain
      .then(function () {
        state.orbit = collected;
        drawOrbit();
      })
      .catch(function (error) {
        console.warn("Orbit prediction unavailable:", error.message);
      });
  }

  /* ===========================================================
     Rendering
     =========================================================== */

  function setStatus(level, text) {
    document.querySelector(".status__dot").dataset.state = level;
    $("status-text").textContent = text;
  }

  function render(position) {
    var metric = state.units === "metric";

    $("lat").textContent = formatSigned(position.lat, "N", "S");
    $("lat-dms").textContent = toDMS(position.lat, "north", "south");
    $("lon").textContent = formatSigned(position.lon, "E", "W");
    $("lon-dms").textContent = toDMS(position.lon, "east", "west");

    $("alt").textContent = metric
      ? position.alt.toFixed(1) + " km"
      : (position.alt / KM_PER_MILE).toFixed(1) + " mi";

    $("vel").textContent = metric
      ? Math.round(position.velocity).toLocaleString() + " km/h"
      : Math.round(position.velocity / KM_PER_MILE).toLocaleString() + " mph";
    $("vel-note").textContent = metric
      ? (position.velocity / 3600).toFixed(2) + " km/s — one orbit every ~93 min"
      : (position.velocity / 3600 / KM_PER_MILE).toFixed(2) + " mi/s — one orbit every ~93 min";

    var sunlit = position.visibility === "daylight";
    $("vis").textContent = sunlit ? "Sunlit" : "Eclipsed";
    $("vis-note").textContent = sunlit
      ? "The station is in direct sunlight"
      : "The station is in Earth’s shadow";

    var when = new Date(position.timestamp * 1000);
    $("time-local").textContent = formatTime(when);
    $("time-utc").textContent = formatTime(when, "UTC") + " UTC";

    renderDistance(position);
    setStatus("live", "Live · updated " + when.toLocaleTimeString());
  }

  function renderDistance(position) {
    if (!state.observer) return;

    var slant = slantRangeKm(state.observer, position);
    var ground = groundDistanceKm(state.observer, position);
    var overhead = ground <= position.footprint;

    $("dist").textContent = state.units === "metric"
      ? Math.round(slant).toLocaleString() + " km"
      : Math.round(slant / KM_PER_MILE).toLocaleString() + " mi";

    var groundValue = state.units === "metric" ? ground : ground / KM_PER_MILE;
    $("dist-note").textContent = overhead
      ? "Above your horizon right now — look up"
      : Math.round(groundValue).toLocaleString() +
        (state.units === "metric" ? " km" : " mi") +
        " away across the ground";
  }

  function markStaleIfNeeded() {
    if (!state.lastSuccess || state.backoff) return;
    var age = Date.now() - state.lastSuccess;
    if (age > STALE_MS) {
      setStatus("stale", "Waiting for data…");
    }
  }

  /* ===========================================================
     Controls
     =========================================================== */

  function setToggle(button, on) {
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", String(on));
  }

  function setFollow(on) {
    state.follow = on;
    setToggle($("btn-follow"), on);
    if (on && state.rendered) commitMarker();
    persist();
  }

  function persist() {
    savePrefs({
      follow: state.follow,
      showTrail: state.showTrail,
      showNight: state.showNight,
      units: state.units,
      basemap: currentBasemap,
    });
  }

  function setTrackVisible(on) {
    state.showTrail = on;
    layers.trail.setVisible(on);
    layers.orbit.setVisible(on);
    layers.footprint.setVisible(on);
    setToggle($("btn-track"), on);
    persist();
  }

  function setNightVisible(on) {
    state.showNight = on;
    layers.night.setVisible(on);
    setToggle($("btn-night"), on);
    persist();
  }

  function setUnits(units) {
    state.units = units;
    setToggle($("btn-metric"), units === "metric");
    setToggle($("btn-imperial"), units === "imperial");
    if (state.latest) render(state.latest);
    persist();
  }

  function wireControls() {
    $("btn-follow").addEventListener("click", function () {
      setFollow(!state.follow);
    });

    $("btn-track").addEventListener("click", function () {
      setTrackVisible(!state.showTrail);
    });

    $("btn-night").addEventListener("click", function () {
      setNightVisible(!state.showNight);
    });

    $("btn-basemap").addEventListener("click", function () {
      var next = currentBasemap === "dark" ? "satellite" : "dark";
      setBasemap(next);
      $("btn-basemap").textContent = BASEMAPS[next].nextLabel;
      setToggle($("btn-basemap"), next === "satellite");
      persist();
    });

    $("btn-metric").addEventListener("click", function () {
      setUnits("metric");
    });
    $("btn-imperial").addEventListener("click", function () {
      setUnits("imperial");
    });

    $("btn-locate").addEventListener("click", function () {
      var button = this;
      if (!navigator.geolocation) {
        button.textContent = "Geolocation unavailable";
        return;
      }
      button.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          state.observer = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          features.observer.setGeometry(
            new ol.geom.Point(ol.proj.fromLonLat([state.observer.lon, state.observer.lat]))
          );
          button.textContent = "Update location";
          if (state.latest) renderDistance(state.latest);
        },
        function () {
          button.textContent = "Location denied";
        },
        { enableHighAccuracy: false, timeout: 10000 }
      );
    });
  }

  function applyPrefs() {
    var prefs = loadPrefs();

    if (prefs.basemap && BASEMAPS[prefs.basemap]) {
      setBasemap(prefs.basemap);
      $("btn-basemap").textContent = BASEMAPS[prefs.basemap].nextLabel;
      setToggle($("btn-basemap"), prefs.basemap === "satellite");
    }
    if (prefs.units === "imperial") setUnits("imperial");
    if (prefs.follow === false) setFollow(false);
    if (prefs.showTrail === false) setTrackVisible(false);
    if (prefs.showNight === false) setNightVisible(false);
  }

  /* ===========================================================
     Boot
     =========================================================== */

  function init() {
    buildMap();
    wireControls();
    applyPrefs();

    drawNight();
    setInterval(drawNight, 60000);

    setStatus("loading", "Connecting…");
    poll();

    refreshOrbit();
    setInterval(refreshOrbit, ORBIT_REFRESH_MS);

    setInterval(markStaleIfNeeded, 5000);

    // Catch up immediately when the tab comes back to the foreground.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        schedule(0);
        drawNight();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
