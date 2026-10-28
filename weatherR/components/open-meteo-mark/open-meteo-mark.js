/* Отдельный знак weatherR.
   В index.html и app.js не подключён.
   R зелёная, только если Open-Meteo ответил и вошёл в среднее.
   Иначе R белая. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.weatherROpenMeteoMark = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var SOURCE = "open-meteo";

  function included(report) {
    if (!report) return false;
    var sources = report.sources;
    if (Array.isArray(sources)) return sources.indexOf(SOURCE) !== -1;
    var readings = report.readings;
    if (!Array.isArray(readings)) return false;
    return readings.some(function (row) {
      return row && row.source === SOURCE && row.ok === true && row.temp_c != null;
    });
  }

  function paint(letter, report) {
    var on = included(report);
    letter.classList.toggle("is-on", on);
    letter.classList.toggle("is-off", !on);
    letter.title = on ? "Open-Meteo вошёл в среднее" : "Open-Meteo не поступил";
    return on;
  }

  function mount(host, report) {
    host.textContent = "";
    host.classList.add("wx-brand");
    var word = document.createElement("span");
    word.className = "wx-brand-word";
    word.appendChild(document.createTextNode("weather"));
    var letter = document.createElement("span");
    letter.className = "wx-brand-r";
    letter.textContent = "R";
    word.appendChild(letter);
    host.appendChild(word);
    paint(letter, report);
    return {
      update: function (next) {
        return paint(letter, next);
      }
    };
  }

  return { SOURCE: SOURCE, included: included, mount: mount };
});
