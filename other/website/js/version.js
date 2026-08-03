(function () {
  // Single source of truth for the current build: vca-current-version.txt (one
  // line, e.g. "1.0.2"). The version number shown in the "Get the app" section
  // and the download link URLs are assembled from it at runtime, so a release
  // only needs that file bumped — the page follows automatically. Elements opt in:
  //   [data-version]        → textContent is set to the version
  //   [data-href-template]  → href is built by replacing {version} in the template
  // There is no hardcoded fallback: until this resolves the version span is empty
  // and the download buttons have no href, so a bad/missing file fails loudly.
  fetch("vca-current-version.txt", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    })
    .then(function (text) {
      var version = text.trim();
      if (!version) return;
      document.querySelectorAll("[data-version]").forEach(function (el) {
        el.textContent = version;
      });
      document.querySelectorAll("[data-href-template]").forEach(function (el) {
        var url = el.getAttribute("data-href-template").replace(/\{version\}/g, version);
        el.setAttribute("href", url);
      });
    })
    .catch(function (err) {
      console.error("Could not load vca-current-version.txt — version and download links not set.", err);
    });
})();
