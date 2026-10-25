// Runs before the app: lets the Google Fonts sheet apply once it has loaded,
// so the first paint is never blocked on a font request. Lives in a file (not
// an inline onload handler) so the Content-Security-Policy can forbid inline
// scripts altogether (audit F7, 25 Oct 2026).
(function () {
  var link = document.getElementById('hub-fonts');
  if (!link) return;
  var apply = function () { link.media = 'all'; };
  if (link.sheet) { apply(); return; }
  link.addEventListener('load', apply, { once: true });
  // A blocked font host must never leave the page on print-only styles.
  setTimeout(apply, 3000);
})();
