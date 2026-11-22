// Huginn command center: when it runs inside the Huginn Android app (Capacitor), not a browser.
// Android's back button closes whatever is open, one step at a time, then puts the app away.
"use strict";

const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (NATIVE) {
  document.body.classList.add("inApp");
  const AppPlugin = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (AppPlugin) AppPlugin.addListener("backButton", () => {
    const log = document.querySelector(".log.open");
    if (!drawer.hidden) return closeDrawer();
    if (S.placing) return stopPlacing();
    if (S.houseEdit) { S.houseEdit = false; renderPanel(); saveHouse(); return; }
    if (S.replay) return stopReplay();
    if (log) return $("logBtn").click();
    if (S.view === "house") return setView("sky");
    AppPlugin.minimizeApp();
  });
}
