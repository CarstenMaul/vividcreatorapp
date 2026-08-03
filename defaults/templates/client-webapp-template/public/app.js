// App entry point. Everything runs client-side; persist state with
// localStorage/IndexedDB and keep all asset URLs relative.
document.addEventListener("DOMContentLoaded", () => {
  const visits = Number(localStorage.getItem("visits") || "0") + 1;
  localStorage.setItem("visits", String(visits));
  if (visits > 1) {
    document.querySelector(".hint").textContent = `Welcome back — visit #${visits}.`;
  }
});
