"use strict";

const renderValue = {
    zoom: value => `${+value.toFixed(1)}x`,
    size: value => `${Math.round(value)}px`,
    zoomSpeed: value => `${value.toFixed(3)}x`,
    delay: value => `${Math.round(value)}ms`,
};

chrome.storage.local.get(DEFAULT_SETTINGS).then(stored => {
    for (const key in DEFAULT_SETTINGS) {
        const input = document.getElementById(key);

        if (input.type === "checkbox") {
            input.checked = stored[key];
            input.addEventListener("change", () => chrome.storage.local.set({ [key]: input.checked }));
            continue;
        }

        const output = document.querySelector(`output[for=${key}]`);
        const save = debounce(value => chrome.storage.local.set({ [key]: value }));
        input.value = stored[key];
        output.textContent = renderValue[key](stored[key]);
        input.addEventListener("input", () => {
            output.textContent = renderValue[key](input.valueAsNumber);
            save(input.valueAsNumber);
        });
    }
});
