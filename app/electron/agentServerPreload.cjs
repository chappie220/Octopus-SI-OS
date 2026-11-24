const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  const address = document.querySelector("#server-address");
  const submit = document.querySelector("button");
  const error = document.querySelector("#connection-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Connecting…";
    error.textContent = "";
    try {
      await ipcRenderer.invoke("octopus:connect-agent-server", address.value);
    } catch (failure) {
      error.textContent = failure.message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError): /, "");
      submit.disabled = false;
      submit.textContent = "Connect";
    }
  });
});
