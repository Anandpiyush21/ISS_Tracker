
function fetchIssData() {
  const apiUrl = 'https://api.wheretheiss.at/v1/satellites/25544';

  fetch(apiUrl)
      .then(response => {
          if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
      })
      .then(data => {
          const position = data;

          document.getElementById('lat').innerText = `Latitude: ${position.latitude.toFixed(6)}`;
          document.getElementById('lon').innerText = `Longitude: ${position.longitude.toFixed(6)}`;
          document.getElementById('alt').innerText = `Altitude: ${position.altitude.toFixed(2)} km`; // Altitude is in km
          document.getElementById('velocity').innerText = `Velocity: ${position.velocity.toFixed(2)} km/s`; // Velocity in km/s
          document.getElementById('visibility').innerText = `Visibility: ${position.visibility}`;
          document.getElementById('timestamp').innerText = `Time(IST): ${convertTimestampToIST(position.timestamp)}`;

          updateMap(position.latitude, position.longitude);

          document.getElementById('map-loading').style.display = 'none';
      })
      .catch(error => {
          console.error('Failed to fetch ISS data:', error);
          document.getElementById('map-loading').innerText = 'Failed to load ISS data.';
      });
}
function convertTimestampToIST(timestamp) {
  const date = new Date(timestamp * 1000); 
  const options = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Kolkata',
      hour12: false
  };
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

function updateMap(lat, lon) {
  if (window.marker) {
      window.marker.getSource().clear();
  }

  window.marker = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
      name: 'ISS'
  });

  const vectorSource = new ol.source.Vector({
      features: [window.marker]
  });

  function getIconScale(zoom) {
      return Math.max(0.5, Math.min(zoom / 10, 2.0)); 
  }

  const iconStyle = new ol.style.Style({
      image: new ol.style.Icon({
          anchor: [0.5, 0.5],
          anchorXUnits: 'fraction',
          anchorYUnits: 'fraction',
          src: 'iss.png',
          scale: getIconScale(window.map.getView().getZoom()) 
      })
  });

  window.marker.setStyle(iconStyle);

  const vectorLayer = new ol.layer.Vector({
      source: vectorSource
  });

  window.map.addLayer(vectorLayer);
  window.map.getView().setCenter(ol.proj.fromLonLat([lon, lat]));
}

window.onload = function() {
  window.map = new ol.Map({
      target: 'map',
      layers: [
          new ol.layer.Tile({
              source: new ol.source.OSM()
          })
      ],
      view: new ol.View({
          center: ol.proj.fromLonLat([0, 0]),
          zoom: 2,
          minZoom: 2, 
          maxZoom: 12 
      })
  });

  document.getElementById('map-loading').innerText = 'Loading...';

  fetchIssData();

  setInterval(fetchIssData, 1000);

  window.map.getView().on('change:resolution', function() {
      if (window.marker) {
          window.marker.setStyle(new ol.style.Style({
              image: new ol.style.Icon({
                  anchor: [0.5, 0.5],
                  anchorXUnits: 'fraction',
                  anchorYUnits: 'fraction',
                  src: 'iss.png',
                  scale: getIconScale(window.map.getView().getZoom())
              })
          }));
      }
  });
};

function getIconScale(zoom) {
  return Math.max(0.5, Math.min(zoom / 10, 2.0)); 
}
