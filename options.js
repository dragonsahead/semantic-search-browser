const tokenInput = document.getElementById("token");
const openaiKeyInput = document.getElementById("openai-key");
const scopeType = document.getElementById("scope-type");
const scopeValue = document.getElementById("scope-value");
const saveBtn = document.getElementById("save");
const toast = document.getElementById("toast");

const PLACEHOLDERS = {
  none: "",
  org: "e.g. microsoft",
  repo: "e.g. facebook/react",
};

function updateScopeInput() {
  const type = scopeType.value;
  scopeValue.disabled = type === "none";
  scopeValue.placeholder = PLACEHOLDERS[type] || "";
  if (type === "none") scopeValue.value = "";
}

scopeType.addEventListener("change", updateScopeInput);

chrome.storage.sync.get(["githubToken", "openaiKey", "scopeType", "scopeValue"], (data) => {
  if (data.githubToken) tokenInput.value = data.githubToken;
  if (data.openaiKey) openaiKeyInput.value = data.openaiKey;
  if (data.scopeType) scopeType.value = data.scopeType;
  if (data.scopeValue) scopeValue.value = data.scopeValue;
  updateScopeInput();
});

saveBtn.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      githubToken: tokenInput.value.trim(),
      openaiKey: openaiKeyInput.value.trim(),
      scopeType: scopeType.value,
      scopeValue: scopeValue.value.trim(),
    },
    () => {
      toast.classList.add("visible");
      setTimeout(() => toast.classList.remove("visible"), 2000);
    }
  );
});
