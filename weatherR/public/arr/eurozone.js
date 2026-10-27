/* Плагин еврозоны: читает /arr/eurozone.json и говорит, в какой стране еврозоны точка. */
(function () {
  let database = null;

  function contains(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const crosses = (yi > lat) !== (yj > lat)
        && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  async function load() {
    if (database) return database;
    const response = await fetch("/arr/eurozone.json");
    if (!response.ok) throw new Error("eurozone");
    database = await response.json();
    return database;
  }

  async function countryAt(lat, lon) {
    const data = await load();
    const countries = (data && data.countries) || [];
    return countries.find((country) => contains(lon, lat, country.polygon || [])) || null;
  }

  window.weatherRArr = { load, countryAt };
})();
