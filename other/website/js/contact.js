(function () {
  // Builds mailto: links from a char-code list at runtime, so no plain
  // "user@domain" string ever appears in the page source for scrapers to
  // harvest. Elements get [class=email-protect][data-code="99,97,...']].
  // Add [data-reveal] to also show the address as the link text.
  document.querySelectorAll(".email-protect[data-code]").forEach(function (el) {
    var codes = el.getAttribute("data-code").split(",").map(Number);
    var addr = String.fromCharCode.apply(null, codes);
    el.setAttribute("href", "mailto:" + addr);
    if (el.hasAttribute("data-reveal")) el.textContent = addr;
    el.removeAttribute("data-code");
  });
})();
