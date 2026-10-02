// Only DOM operations in the observed Hashsell React dialog; serialized into the page.
function editorVisible(element) {
  for (let e = element; e; e = e.parentElement) {
    const style = getComputedStyle(e);
    if (
      e.hidden ||
      e.inert ||
      e.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false;
  }
  return true;
}
function hashsellDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
    editorVisible,
  );
  if (dialogs.length !== 1) throw Error("Modal de edição ausente ou ambíguo.");
  return dialogs[0];
}
function openHashsellEditor(id) {
  if (
    location.origin !== "https://hashsell.com" ||
    location.pathname !== `/orders/${id}`
  )
    throw Error("Página da ordem não confere.");
  const buttons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent.trim() === "Ajustar lance" && editorVisible(b),
  );
  if (buttons.length !== 1 || buttons[0].disabled)
    throw Error("Abertura da edição ausente ou ambígua.");
  buttons[0].click();
}
function inspectHashsellEditor(id) {
  if (
    location.origin !== "https://hashsell.com" ||
    location.pathname !== `/orders/${id}`
  )
    throw Error("Identidade da ordem mudou.");
  const dialog = hashsellDialog();
  if (!dialog.textContent.includes("Ajustar lance e limite"))
    throw Error("Modal inesperado.");
  const one = (selector) => {
    const nodes = dialog.querySelectorAll(selector);
    if (nodes.length !== 1) throw Error("Campo ambíguo.");
    return nodes[0];
  };
  const input = one("#adjust-price"),
    limit = one("#adjust-limit");
  const label = [...input.labels].map((l) => l.textContent.trim()).join(" ");
  const unit = label.match(/^Lance, em US\$ por (TH|PH|EH)\/s por dia$/)?.[1];
  if (
    !unit ||
    input.type !== "text" ||
    limit.type !== "text" ||
    input.disabled ||
    input.readOnly ||
    !editorVisible(input) ||
    limit.disabled ||
    !input.form ||
    input.form !== limit.form
  )
    throw Error("Contrato do campo de lance mudou.");
  const limitUnit = [...limit.labels]
    .map((l) => l.textContent.trim())
    .join(" ")
    .match(/^Limite, em (TH|PH|EH)\/s$/)?.[1];
  if (unit !== limitUnit) throw Error("Unidades divergentes no modal.");
  const saves = [...dialog.querySelectorAll("button")].filter(
    (b) => b.textContent.trim() === "Salvar ajuste",
  );
  if (
    saves.length !== 1 ||
    saves[0].type !== "button" ||
    !editorVisible(saves[0]) ||
    saves[0].form !== input.form ||
    limit.form !== input.form
  )
    throw Error("Ação de salvar mudou.");
  return {
    id,
    href: location.href,
    value: input.value,
    limit: limit.value,
    unit,
    disabled: saves[0].disabled,
    error: [
      ...dialog.querySelectorAll('[role="alert"],[data-slot="field-error"]'),
    ]
      .map((e) => e.textContent.trim())
      .filter(Boolean)
      .join(" "),
  };
}
function fillHashsellEditor(expected) {
  const info = inspectHashsellEditor(expected.id);
  if (
    info.value !== expected.original ||
    info.limit !== expected.limit ||
    info.href !== expected.href
  )
    throw Error("Lance ou limite mudou antes do preenchimento.");
  verifyBidText(expected.value, expected.authority, info.unit);
  const input = hashsellDialog().querySelector("#adjust-price");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    input,
    expected.value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}
function commitHashsellEditor(expected) {
  const info = inspectHashsellEditor(expected.id);
  if (
    info.href !== expected.href ||
    info.limit !== expected.limit ||
    info.disabled ||
    info.error
  )
    throw Error("Campo, limite ou botão mudou antes de salvar.");
  verifyBidText(info.value, expected.authority, info.unit);
  const input = hashsellDialog().querySelector("#adjust-price");
  if (!input.checkValidity() || !input.form?.checkValidity())
    throw Error("Campo inválido.");
  const buttons = [
    ...input.closest('[role="dialog"]').querySelectorAll("button"),
  ].filter((b) => b.textContent.trim() === "Salvar ajuste");
  if (buttons.length !== 1) throw Error("Salvar ambíguo.");
  buttons[0].click();
  return { submitted: true };
}
function editorScript(fn, ...args) {
  const { verifyBidText } = require("./bid-safety.cjs");
  return `(()=>{const verifyBidText=${verifyBidText.toString()};const editorVisible=${editorVisible.toString()};const hashsellDialog=${hashsellDialog.toString()};const inspectHashsellEditor=${inspectHashsellEditor.toString()};return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")});})()`;
}
function commitHashsellConfirmation(expected) {
  if (
    location.href !== expected.href ||
    location.origin !== "https://hashsell.com" ||
    location.pathname !== `/orders/${expected.id}`
  )
    throw Error("Ordem mudou antes da confirmação final.");
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  const candidates = [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'),
  ].filter((dialog) => {
    if (!editorVisible(dialog) || dialog.querySelector("#adjust-price"))
      return false;
    const title = dialog.querySelector(
      'h1,h2,h3,[data-slot="dialog-title"],[data-slot="alert-dialog-title"]',
    );
    const text = normalize(dialog.textContent);
    return (
      normalize(title?.textContent || "") === "Ajustar lance e limite" &&
      text.includes(
        "Passa a valer no próximo tick e muda quanto esta ordem recebe e quanto ela gasta por dia.",
      ) &&
      text.includes(
        "Reduzir tem intervalo de espera: depois de salvar, a próxima redução só vale mais tarde.",
      )
    );
  });
  if (candidates.length !== 1)
    throw Error(
      "Confirmação final de ajuste ausente ou diferente da tela validada.",
    );
  const dialog = candidates[0];
  const buttons = [...dialog.querySelectorAll("button")].filter(editorVisible);
  const saves = buttons.filter(
    (b) => normalize(b.textContent) === "Salvar ajuste",
  );
  if (
    buttons.length !== 2 ||
    saves.length !== 1 ||
    saves[0].disabled ||
    !buttons.some((b) => normalize(b.textContent) === "Voltar")
  )
    throw Error("Botões da confirmação final não conferem.");
  // The background form may be inert/aria-hidden while the confirmation is open.
  // Read its values again, but never click through it or change its attributes.
  const prices = document.querySelectorAll("#adjust-price");
  const limits = document.querySelectorAll("#adjust-limit");
  if (
    prices.length !== 1 ||
    limits.length !== 1 ||
    limits[0].value !== expected.limit ||
    !prices[0].form ||
    limits[0].form !== prices[0].form
  )
    throw Error("Formulário original ou limite mudou antes da confirmação.");
  const unit = [...prices[0].labels]
    .map((l) => normalize(l.textContent))
    .join(" ")
    .match(/^Lance, em US\$ por (TH|PH|EH)\/s por dia$/)?.[1];
  verifyBidText(prices[0].value, expected.authority, unit);
  if (!prices[0].checkValidity() || !prices[0].form.checkValidity())
    throw Error("Lance inválido na confirmação.");
  saves[0].click();
  return { confirmationClicked: true };
}
function readHashsellEditorState(id) {
  if (
    location.origin !== "https://hashsell.com" ||
    location.pathname !== `/orders/${id}`
  )
    return { kind: "page-changed", dialogs: [] };
  const dialogs = [
    ...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'),
  ]
    .filter(editorVisible)
    .map((dialog) => ({
      role: dialog.getAttribute("role"),
      title: [
        ...dialog.querySelectorAll(
          'h1,h2,h3,[data-slot="dialog-title"],[data-slot="alert-dialog-title"]',
        ),
      ]
        .map((e) => e.textContent.trim())
        .join(" ")
        .slice(0, 300),
      message: [...dialog.querySelectorAll('p,[role="alert"]')]
        .filter(editorVisible)
        .map((e) => e.textContent.trim())
        .join(" ")
        .slice(0, 1200),
      buttons: [...dialog.querySelectorAll("button")]
        .filter(editorVisible)
        .map((b) => ({
          text: b.textContent.trim().slice(0, 100),
          disabled: b.disabled,
        })),
      price: dialog.querySelector("#adjust-price")?.value ?? null,
      limit: dialog.querySelector("#adjust-limit")?.value ?? null,
    }));
  const form = document.querySelector("#adjust-price")?.form;
  const errors = form
    ? [...form.querySelectorAll('[role="alert"],[data-slot="field-error"]')]
        .filter(editorVisible)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
    : [];
  return {
    errors,
    kind: dialogs.some((d) => d.role === "alertdialog" || d.price === null)
      ? "additional-step"
      : dialogs.length
        ? "editor"
        : "closed",
    dialogs,
  };
}
module.exports = {
  openHashsellEditor,
  inspectHashsellEditor,
  fillHashsellEditor,
  commitHashsellEditor,
  commitHashsellConfirmation,
  readHashsellEditorState,
  editorScript,
};
