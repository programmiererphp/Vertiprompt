import { fetchModels, callOpenRouter } from './openrouter.js';

// --- CONSTANTS ---
const SYSTEM_PROMPT = `
You are *Slice-Synthesiser*, a senior research agent whose sole job is to
break down product ideas into lean, end-to-end feature slices that an AI
coding agent can implement safely and incrementally.

RULES:
1.  **Independent & Testable**: Every slice ships separately and passes a smoke test.
2.  **Small Surface**: ≤ 350 words per prompt.
3.  **Explicit Specs**: State goal, UI, files/modules, and acceptance tests.
4.  **Quality First**: Include a11y, security, error paths, and tests.
5.  **Naming**: "Slice N — <short verb-noun title>".
6.  **Markdown Fence**: Wrap each prompt in \`\`\`prompt fences.
7.  **Output Format**: Strictly follow this format for each slice.

Slice N — <Title>
\`\`\`prompt
# Goal
<One sentence>

# UI / UX
<Concise UI spec>

# Function
<Bullet list of core behaviours>

# Files
<e.g. index.html, main.js, style.css>

# Tests
<smoke test description>

# Acceptance
<pass criteria>

# Constraints
<time, budget, tokens>
\`\`\`
`;

const DEFAULT_MODEL = "perplexity/sonar-deep-research";
const FALLBACK_MODEL = "openrouter/auto";
const LOCAL_STORAGE_KEY = "vertiprompt.last";
const API_KEY_STORAGE_KEY = "vertiprompt.apikey";

// --- DOM ELEMENTS ---
const elements = {
    apiKeyInput: document.getElementById('api-key'),
    promptForm: document.getElementById('prompt-form'),
    descriptionInput: document.getElementById('description'),
    modelSelect: document.getElementById('model-select'),
    iterationsSelect: document.getElementById('iterations-select'),
    generateBtn: document.getElementById('generate-btn'),
    btnText: document.querySelector('#generate-btn .btn-text'),
    spinner: document.querySelector('#generate-btn .spinner'),
    resultsSection: document.getElementById('results-section'),
    resultsHeader: document.querySelector('.results-header'),
    accordionContainer: document.getElementById('results-accordion'),
    costTracker: document.getElementById('cost-tracker'),
    toolbar: {
        copyAllBtn: document.getElementById('copy-all-btn'),
        downloadMdBtn: document.getElementById('download-md-btn'),
        exportJsonBtn: document.getElementById('export-json-btn'),
        importJsonBtn: document.getElementById('import-json-btn'),
        importJsonInput: document.getElementById('import-json-input')
    }
};

// --- STATE ---
let state = {
    slices: [],
    description: '',
    model: DEFAULT_MODEL,
    apiKey: '',
    isGenerating: false,
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', init);

async function init() {
    setupEventListeners();
    loadApiKey();
    await populateModels();
    loadFromLocalStorage();
    // todo: Detect language and offer localization
}

function setupEventListeners() {
    elements.promptForm.addEventListener('submit', handleGenerateClick);
    elements.apiKeyInput.addEventListener('change', (e) => saveApiKey(e.target.value));
    elements.descriptionInput.addEventListener('input', () => {
        elements.descriptionInput.style.height = 'auto';
        elements.descriptionInput.style.height = (elements.descriptionInput.scrollHeight) + 'px';
    });
    
    // Toolbar listeners
    elements.toolbar.copyAllBtn.addEventListener('click', copyAllSlices);
    elements.toolbar.downloadMdBtn.addEventListener('click', downloadAsMarkdown);
    elements.toolbar.exportJsonBtn.addEventListener('click', exportAsJson);
    elements.toolbar.importJsonBtn.addEventListener('click', () => elements.toolbar.importJsonInput.click());
    elements.toolbar.importJsonInput.addEventListener('change', handleImport);

    // Accordion event delegation
    elements.accordionContainer.addEventListener('click', (e) => {
        const header = e.target.closest('.accordion-header');
        if (header) {
            toggleAccordion(header);
        }
        const copyBtn = e.target.closest('.copy-slice-btn');
        if (copyBtn) {
            copySingleSlice(copyBtn.dataset.index);
        }
    });
}

// --- API & DATA HANDLING ---

async function handleGenerateClick(event) {
    event.preventDefault();
    if (state.isGenerating) return;

    state.apiKey = elements.apiKeyInput.value;
    if (!state.apiKey) {
        showToast("Please enter your OpenRouter API Key.", "error");
        elements.apiKeyInput.focus();
        return;
    }
    if (elements.descriptionInput.value.length < 50) {
        showToast("Please provide a more detailed description (min 50 characters).", "error");
        elements.descriptionInput.focus();
        return;
    }

    setGeneratingState(true);
    state.description = elements.descriptionInput.value;
    state.model = elements.modelSelect.value;
    const iterations = parseInt(elements.iterationsSelect.value, 10);
    
    const userPrompt = `PORTAL_DESCRIPTION: """${state.description}"""\n\nNUM_SLICES: 3\nMAX_SLICES: 5`;

    let allSlices = [];
    let totalCost = 0;

    for (let i = 0; i < iterations; i++) {
        showToast(`Generating iteration ${i + 1} of ${iterations}...`, 'info');
        try {
            const result = await generateSlicesWithRetry(userPrompt, state.model);
            const parsedSlices = parseSlices(result.choices[0].message.content);
            allSlices.push(...parsedSlices);
            
            const cost = calculateCost(result);
            totalCost += cost;
            updateCostTracker(totalCost);

        } catch (error) {
            showToast(`Error during iteration ${i + 1}: ${error.message}`, 'error');
            break; 
        }
    }
    
    state.slices = allSlices;
    renderResults(state.slices);
    saveToLocalStorage();
    setGeneratingState(false);
    if (allSlices.length > 0) {
        showToast(`Successfully generated ${allSlices.length} slices.`, 'success');
    }
}

async function generateSlicesWithRetry(userPrompt, primaryModel, retries = 3, backoff = 1000) {
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
    ];

    try {
        return await callOpenRouter({
            apiKey: state.apiKey,
            model: primaryModel,
            messages: messages,
            max_tokens: 2048,
            temperature: 0.3
        });
    } catch (error) {
        if ((error.status === 429 || error.status >= 500) && retries > 0) {
            showToast(`Model busy/error. Retrying in ${backoff / 1000}s...`, 'info');
            await new Promise(resolve => setTimeout(resolve, backoff));
            return generateSlicesWithRetry(userPrompt, primaryModel, retries - 1, backoff * 2);
        } else if (primaryModel !== FALLBACK_MODEL) {
            showToast(`Primary model failed. Trying fallback: ${FALLBACK_MODEL}`, 'info');
            return generateSlicesWithRetry(userPrompt, FALLBACK_MODEL, 2); // Retry fallback as well
        } else {
            throw error;
        }
    }
}

function parseSlices(responseText) {
    const slices = [];
    // Regex to find "Slice N - Title" and the subsequent ```prompt block
    const regex = /(?:^|\n)Slice \d+ — (.*?)\n```prompt([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(responseText)) !== null) {
        slices.push({
            title: match[1].trim(),
            prompt: match[2].trim()
        });
    }
    return slices;
}


// --- UI & RENDERING ---

function setGeneratingState(isGenerating) {
    state.isGenerating = isGenerating;
    elements.generateBtn.disabled = isGenerating;
    elements.spinner.style.display = isGenerating ? 'block' : 'none';
    elements.btnText.textContent = isGenerating ? 'Generating...' : 'Generate Slices';
}

function renderResults(slices) {
    elements.accordionContainer.innerHTML = '';
    if (slices.length === 0) {
        elements.resultsHeader.style.display = 'none';
        return;
    }

    elements.resultsHeader.style.display = 'flex';
    slices.forEach((slice, index) => {
        const item = document.createElement('div');
        item.className = 'accordion-item';
        
        // Use textContent for security
        const titleNode = document.createElement('span');
        titleNode.textContent = `Slice ${index + 1} — ${slice.title}`;

        const header = document.createElement('button');
        header.className = 'accordion-header';
        header.setAttribute('aria-expanded', 'false');
        header.setAttribute('aria-controls', `slice-content-${index}`);
        header.appendChild(titleNode);
        
        const content = document.createElement('div');
        content.id = `slice-content-${index}`;
        content.className = 'accordion-content';
        content.setAttribute('role', 'region');
        
        const pre = document.createElement('pre');
        pre.textContent = slice.prompt;

        const actions = document.createElement('div');
        actions.className = 'slice-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-slice-btn';
        copyBtn.textContent = 'Copy Prompt';
        copyBtn.dataset.index = index;
        
        actions.appendChild(copyBtn);
        content.appendChild(pre);
        content.appendChild(actions);
        item.appendChild(header);
        item.appendChild(content);

        elements.accordionContainer.appendChild(item);
    });
}

function toggleAccordion(header) {
    const item = header.parentElement;
    const content = header.nextElementSibling;
    const isExpanded = header.getAttribute('aria-expanded') === 'true';

    header.setAttribute('aria-expanded', !isExpanded);
    item.toggleAttribute('open', !isExpanded);

    if (!isExpanded) {
        content.style.maxHeight = content.scrollHeight + 'px';
    } else {
        content.style.maxHeight = '0';
    }
}

async function populateModels() {
    showToast("Fetching available models...", "info");
    const models = await fetchModels();
    const filteredModels = models.filter(m => m.id && !m.id.includes('sdxl') && !m.id.includes('dall-e'));

    elements.modelSelect.innerHTML = '';
    
    // Ensure default and fallback are present
    const modelIds = new Set(filteredModels.map(m => m.id));
    if (!modelIds.has(DEFAULT_MODEL)) {
        elements.modelSelect.add(new Option(DEFAULT_MODEL, DEFAULT_MODEL));
    }
     if (!modelIds.has(FALLBACK_MODEL)) {
        elements.modelSelect.add(new Option(FALLBACK_MODEL, FALLBACK_MODEL));
    }

    filteredModels.forEach(model => {
        const option = new Option(`${model.name} (${model.id})`, model.id);
        elements.modelSelect.add(option);
    });
    
    elements.modelSelect.value = state.model || DEFAULT_MODEL;
}

function calculateCost(result) {
    const modelData = result.model; // OpenRouter includes pricing info in the response
    if (modelData && result.usage) {
        const promptCost = (result.usage.prompt_tokens / 1000) * (modelData.pricing.prompt || 0);
        const completionCost = (result.usage.completion_tokens / 1000) * (modelData.pricing.completion || 0);
        return promptCost + completionCost;
    }
    return 0;
}

function updateCostTracker(totalCost) {
    elements.costTracker.textContent = `Estimated Cost: $${totalCost.toFixed(6)}`;
    elements.costTracker.style.display = 'block';
}

// --- PERSISTENCE ---

function saveApiKey(key) {
    state.apiKey = key;
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

function loadApiKey() {
    const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (savedKey) {
        state.apiKey = savedKey;
        elements.apiKeyInput.value = savedKey;
    }
}

function saveToLocalStorage() {
    const dataToSave = {
        runDate: new Date().toISOString(),
        description: state.description,
        model: state.model,
        slices: state.slices,
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(dataToSave));
}

function loadFromLocalStorage() {
    const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedData) {
        try {
            const parsed = JSON.parse(savedData);
            state.slices = parsed.slices || [];
            state.description = parsed.description || '';
            state.model = parsed.model || DEFAULT_MODEL;

            elements.descriptionInput.value = state.description;
            elements.modelSelect.value = state.model;
            
            if (state.slices.length > 0) {
                 renderResults(state.slices);
            }
        } catch (e) {
            console.error("Failed to load from localStorage", e);
            localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
    }
}

// --- TOOLBAR ACTIONS ---
function copyToClipboard(text, successMessage) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(successMessage, 'success');
    }).catch(err => {
        showToast('Failed to copy to clipboard.', 'error');
        console.error('Clipboard error:', err);
    });
}

function copySingleSlice(index) {
    const slice = state.slices[index];
    if (slice) {
        copyToClipboard(slice.prompt, `Slice ${parseInt(index, 10) + 1} prompt copied!`);
    }
}

function copyAllSlices() {
    if (state.slices.length === 0) return;
    const allText = state.slices.map((s, i) => `## Slice ${i + 1} — ${s.title}\n\n\`\`\`\n${s.prompt}\n\`\`\``).join('\n\n---\n\n');
    copyToClipboard(allText, 'All slices copied to clipboard!');
}

function downloadFile(content, fileName, contentType) {
    const a = document.createElement("a");
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
}

function downloadAsMarkdown() {
    if (state.slices.length === 0) return;
    const allText = state.slices.map((s, i) => `## Slice ${i + 1} — ${s.title}\n\n\`\`\`prompt\n${s.prompt}\n\`\`\``).join('\n\n');
    downloadFile(allText, 'vertiprompt-slices.md', 'text/markdown');
}

function exportAsJson() {
    if (state.slices.length === 0) return;
    const exportData = {
        schemaVersion: '1.0',
        runDate: new Date().toISOString(),
        description: state.description,
        model: state.model,
        slices: state.slices
    };
    downloadFile(JSON.stringify(exportData, null, 2), 'vertiprompt-export.json', 'application/json');
}

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > 200 * 1024) { // 200 KB limit
        showToast('File is too large (max 200KB).', 'error');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.schemaVersion !== '1.0' || !Array.isArray(data.slices)) {
                throw new Error("Invalid or unsupported file format.");
            }
            state.description = data.description || '';
            state.model = data.model || DEFAULT_MODEL;
            state.slices = data.slices;

            elements.descriptionInput.value = state.description;
            elements.modelSelect.value = state.model;
            renderResults(state.slices);
            saveToLocalStorage();
            showToast('Successfully imported slices!', 'success');
        } catch (error) {
            showToast(`Import failed: ${error.message}`, 'error');
        } finally {
            // Reset file input to allow re-importing the same file
            elements.toolbar.importJsonInput.value = '';
        }
    };
    reader.readAsText(file);
}

// --- UTILITIES ---

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    // Use textContent for security against XSS in messages
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}

// --- MANUAL TESTING NOTES ---
/*
To create a manual smoke test file (`test.html`):
1. Create a new HTML file.
2. Include `<script type="module" src="app.js"></script>`.
3. You can't directly call functions from the module in the console, but you can
   attach key functions to the `window` object for testing purposes inside app.js, e.g.:
   `window.testGenerate = handleGenerateClick;`
   Then you could call `testGenerate()` from the console in `test.html`.
4. This approach allows isolating and testing JS logic without the full UI.
*/
// todo: Add a dark-mode toggle switch instead of only respecting prefers-color-scheme.