// Webview script of the "Create PKGBUILD" form. The extension owns the logic: this sends every change and shows
// the values, preview and errors it gets back.
(function () {
  const vscode = acquireVsCodeApi();
  const form = document.getElementById("form");
  const preview = document.getElementById("preview");
  const errorList = document.getElementById("errors");
  const target = document.getElementById("target");
  const createButton = document.getElementById("create");
  let edited = new Set();
  let hints = {};
  let timer = null;
  // Responses to older changes are ignored, so a slow reply can't undo newer typing
  let seq = 0;

  function collect() {
    const values = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") values[el.name] = el.checked;
      else if (el.type === "radio") { if (el.checked) values[el.name] = el.value; }
      else values[el.name] = el.value;
    }
    return values;
  }

  function apply(values) {
    for (const el of form.elements) {
      if (!el.name || !(el.name in values)) continue;
      // Don't fight the user over the field they're typing in
      if (el === document.activeElement && el.type === "text") continue;
      const value = values[el.name];
      if (el.type === "checkbox") el.checked = !!value;
      else if (el.type === "radio") el.checked = el.value === value;
      else el.value = value;
    }
    document.body.classList.toggle("is-git", values.kind === "git");
  }

  function updateHints() {
    for (const el of document.querySelectorAll("[data-hint]")) {
      const name = el.dataset.hint;
      el.textContent = hints[name] && !edited.has(name) ? `from ${hints[name]}` : "";
    }
  }

  function fillSelect(name, options) {
    const select = form.elements.namedItem(name);
    const current = select.value;
    select.replaceChildren(...options.map(o => new Option(o.label, o.value)));
    if (options.some(o => o.value === current)) select.value = current;
  }

  function send(type) {
    vscode.postMessage({ type, values: collect(), edited: [...edited], seq: ++seq });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => send("change"), 200);
  }

  form.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.name) return;
    // An emptied text field goes back to its detected value
    if (el.type === "text" && el.value === "") edited.delete(el.name);
    else edited.add(el.name);
    updateHints();
    schedule();
  });
  form.addEventListener("change", (e) => {
    if (e.target.name && e.target.type !== "text") {
      edited.add(e.target.name);
      updateHints();
      schedule();
    }
  });
  form.addEventListener("focusout", () => schedule());
  form.addEventListener("submit", (e) => e.preventDefault());

  createButton.addEventListener("click", () => {
    clearTimeout(timer);
    send("create");
  });
  document.getElementById("reset").addEventListener("click", () => {
    clearTimeout(timer);
    edited.clear();
    vscode.postMessage({ type: "reset", seq: ++seq });
  });
  document.getElementById("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

  window.addEventListener("message", (e) => {
    const message = e.data;
    if (message.type === "init") {
      fillSelect("root", message.options.roots);
      fillSelect("buildSystem", message.options.buildSystems);
      fillSelect("pkgverSource", message.options.pkgverSources);
      hints = message.hints;
      document.body.classList.toggle("multi-root", message.options.roots.length > 1);
      document.body.classList.toggle("has-license", !!message.licenseFile);
      document.getElementById("license-file").textContent = message.licenseFile ?? "";
      updateHints();
    }
    else if (message.type === "update") {
      if (message.seq !== undefined && message.seq !== seq) return;
      edited = new Set(message.edited);
      apply(message.values);
      updateHints();
      preview.textContent = message.preview;
      target.textContent = message.target;
      errorList.replaceChildren(...message.errors.map(text => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }));
      createButton.disabled = message.errors.length > 0;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
