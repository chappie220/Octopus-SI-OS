(function () {
  if (window.__octopusBootMounted) return;
  var statusEl = document.getElementById("startup-loader-status");
  var actionEl = document.getElementById("startup-loader-retry");
  if (!statusEl || !actionEl) return;

  var settled = false;
  var slowTimer = null;
  var retryButtonTimer = null;
  var stallTimer = null;
  var autoReloadTimer = null;

  function cleanup() {
    settled = true;
    if (slowTimer) window.clearTimeout(slowTimer);
    if (retryButtonTimer) window.clearTimeout(retryButtonTimer);
    if (stallTimer) window.clearTimeout(stallTimer);
    if (autoReloadTimer) window.clearTimeout(autoReloadTimer);
    window.removeEventListener("error", onResourceError, true);
    window.removeEventListener("online", onOnline);
  }

  function isMounted() {
    if (window.__octopusBootMounted || !document.getElementById("startup-loader-status")) {
      cleanup();
      return true;
    }
    return false;
  }

  function showStatus(text, showRetry) {
    if (isMounted()) return;
    statusEl.textContent = text;
    statusEl.hidden = false;
    if (showRetry) actionEl.hidden = false;
  }

  function scheduleReload() {
    if (isMounted() || autoReloadTimer) return;
    var retries = 0;
    try {
      retries = Number(window.sessionStorage.getItem("octopus_boot_retries") || "0");
    } catch (_) {}
    if (retries >= 3) {
      showStatus("Unable to finish loading Octopus on this network. Tap Retry to try again.", true);
      return;
    }
    showStatus("Connection is slow or interrupted. Retrying…", true);
    var delayMs = Math.min(12000, 3000 * Math.pow(2, retries));
    autoReloadTimer = window.setTimeout(function () {
      if (isMounted()) return;
      try {
        window.sessionStorage.setItem("octopus_boot_retries", String(retries + 1));
      } catch (_) {}
      window.location.reload();
    }, delayMs);
  }

  function onResourceError(event) {
    if (settled || isMounted()) return;
    var target = event && event.target;
    if (target && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
      scheduleReload();
    }
  }

  function onOnline() {
    if (settled || isMounted()) return;
    if (!actionEl.hidden) {
      window.location.reload();
    }
  }

  actionEl.addEventListener("click", function () {
    try {
      window.sessionStorage.removeItem("octopus_boot_retries");
    } catch (_) {}
    window.location.reload();
  });

  window.addEventListener("error", onResourceError, true);
  window.addEventListener("online", onOnline);

  slowTimer = window.setTimeout(function () {
    showStatus("Loading Octopus…", false);
  }, 5000);

  retryButtonTimer = window.setTimeout(function () {
    showStatus("Still loading on a slow connection…", true);
  }, 15000);

  stallTimer = window.setTimeout(function () {
    scheduleReload();
  }, 45000);
})();
