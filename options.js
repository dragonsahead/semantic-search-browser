const tokenInput = document.getElementById("token");
const openaiKeyInput = document.getElementById("openai-key");
const scopeType = document.getElementById("scope-type");
const scopeValue = document.getElementById("scope-value");
const deepwikiEnabled = document.getElementById("deepwiki-enabled");
const deepwikiRepo = document.getElementById("deepwiki-repo");
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

  if (type === "repo" && scopeValue.value.trim() && !deepwikiRepo.value.trim()) {
    deepwikiRepo.value = scopeValue.value.trim();
  }
  if (type === "repo" && scopeValue.value.trim() && deepwikiEnabled.dataset.userSet !== "true") {
    deepwikiEnabled.checked = true;
  }
}

scopeType.addEventListener("change", updateScopeInput);
scopeValue.addEventListener("input", updateScopeInput);
deepwikiEnabled.addEventListener("change", () => {
  deepwikiEnabled.dataset.userSet = "true";
});

chrome.storage.sync.get(
  ["githubToken", "openaiKey", "scopeType", "scopeValue", "deepwikiEnabled", "deepwikiRepo"],
  (data) => {
    if (data.githubToken) tokenInput.value = data.githubToken;
    if (data.openaiKey) openaiKeyInput.value = data.openaiKey;
    if (data.scopeType) scopeType.value = data.scopeType;
    if (data.scopeValue) scopeValue.value = data.scopeValue;

    if (data.deepwikiRepo) {
      deepwikiRepo.value = data.deepwikiRepo;
    } else if (data.scopeType === "repo" && data.scopeValue) {
      deepwikiRepo.value = data.scopeValue;
    }

    if (typeof data.deepwikiEnabled === "boolean") {
      deepwikiEnabled.checked = data.deepwikiEnabled;
      deepwikiEnabled.dataset.userSet = "true";
    } else if (data.scopeType === "repo" && data.scopeValue) {
      deepwikiEnabled.checked = true;
    }

    updateScopeInput();
  }
);

saveBtn.addEventListener("click", () => {
  chrome.storage.sync.set(
    {
      githubToken: tokenInput.value.trim(),
      openaiKey: openaiKeyInput.value.trim(),
      scopeType: scopeType.value,
      scopeValue: scopeValue.value.trim(),
      deepwikiEnabled: deepwikiEnabled.checked,
      deepwikiRepo: deepwikiRepo.value.trim(),
    },
    () => {
      toast.classList.add("visible");
      setTimeout(() => toast.classList.remove("visible"), 2000);
    }
  );
});
