import { fetchModels, callOpenRouter } from './openrouter.js';
// Import all prompts and configurations from the new external file.
import { 
    SYSTEM_PROMPT, 
    CURATED_MODELS, 
    DEFAULT_MODEL, 
    FALLBACK_MODEL,
    LOCAL_STORAGE_KEY,
    API_KEY_STORAGE_KEY
} from './prompts-config.js';

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
    debugLogContent: document.getElementById('debug-log-content'),
    copyLogBtn: document.getElementById('copy-log-btn'),
    toolbar: {
        copyAllBtn: document.getElementById('copy-all-btn'),
        downloadMdBtn: document.getElementById('download-md-btn'),
        exportJsonBtn: document.getElementById('export-json-btn'),
        importJsonBtn: document.getElementById('import-json-btn'),
        importJsonInput: document.getElementById('import-json-input'),
        cleanSlicesBtn: document.getElementById('clean-slices-btn')
    }
};

// --- STATE ---
let state = {
    slices: [],
    description: '',
    model: DEFAULT_MODEL,
    apiKey: '',
    isGenerating: false,
    models: CURATED_MODELS, // Use the curated list from config
};

// --- DEBUG LOGGER ---
function log(message, data) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    let logMessage = `[${timestamp}] ${message}`;
    if (data) {
        const sanitizedData = JSON.stringify(data, (key, value) => 
            key.toLowerCase().includes('key') ? '********' : value, 2);
        logMessage += `\n${sanitizedData}`;
    }
    const currentLog = elements.debugLogContent.textContent;
    const newLog = currentLog.startsWith('Logger initialized') 
        ? `${logMessage}\n` 
        : `${currentLog}\n${logMessage}`;
    elements.debugLogContent.textContent = newLog;
    elements.debugLogContent.scrollTop = elements.debugLogContent.scrollHeight;
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', init);

function init() {
    log('Application Initializing');
    setupEventListeners();
    loadApiKey();
    populateModels();
    loadFromLocalStorage();
}

function setupEventListeners() {
    elements.promptForm.addEventListener('submit', (e) => { log('Event: Generate form submitted'); handleGenerateClick(e); });
    elements.apiKeyInput.addEventListener('change', (e) => saveApiKey(e.target.value));
    elements.descriptionInput.addEventListener('input', () => { elements.descriptionInput.style.height = 'auto'; elements.descriptionInput.style.height = (elements.descriptionInput.scrollHeight) + 'px'; });
    elements.toolbar.copyAllBtn.addEventListener('click', () => { log('Event: "Copy All" button clicked'); copyAllSlices(); });
    elements.toolbar.downloadMdBtn.addEventListener('click', () => { log('Event: "Download MD" button clicked'); downloadAsMarkdown(); });
    elements.toolbar.exportJsonBtn.addEventListener('click', () => { log('Event: "Export JSON" button clicked'); exportAsJson(); });
    elements.toolbar.importJsonBtn.addEventListener('click', () => { log('Event: "Import JSON" button clicked'); elements.toolbar.importJsonInput.click(); });
    elements.toolbar.importJsonInput.addEventListener('change', (e) => { log('Event: JSON file selected for import'); handleImport(e); });
    elements.toolbar.cleanSlicesBtn.addEventListener('click', () => { log('Event: "Clean" button clicked'); cleanSlices(); });
    elements.copyLogBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); log('Event: "Copy Log" button clicked'); copyDebugLog(); });
    elements.accordionContainer.addEventListener('click', (e) => {
        const header = e.target.closest('.accordion-header');
        if (header) { log('Event: Accordion header clicked'); toggleAccordion(header); }
        const copyBtn = e.target.closest('.copy-slice-btn');
        if (copyBtn) { log(`Event: "Copy Slice ${parseInt(copyBtn.dataset.index, 10) + 1}" button clicked`); copySingleSlice(copyBtn.dataset.index); }
    });
    log('Event Listeners have been set up.');
}

// --- API & DATA HANDLING ---

async function handleGenerateClick(event) {
    event.preventDefault();
    if (state.isGenerating) { log('Generation attempt while already running. Aborted.'); return; }
    state.apiKey = elements.apiKeyInput.value;
    if (!state.apiKey) { log('Validation failed: API key is missing.'); showToast("Please enter your OpenRouter API Key.", "error"); elements.apiKeyInput.focus(); return; }
    if (elements.descriptionInput.value.length < 50) { log('Validation failed: Description too short.', { length: elements.descriptionInput.value.length }); showToast("Please provide a more detailed description (min 50 characters).", "error"); elements.descriptionInput.focus(); return; }
    
    setGeneratingState(true);
    state.description = elements.descriptionInput.value;
    state.model = elements.modelSelect.value;
    const iterations = parseInt(elements.iterationsSelect.value, 10);
    log('Starting generation process...', { model: state.model, iterations });
    const userPrompt = `PORTAL_DESCRIPTION: """${state.description}"""\n\nNUM_SLICES: 3\nMAX_SLICES: 5`;
    let allSlices = [];
    let totalCost = 0;

    for (let i = 0; i < iterations; i++) {
        log(`Starting iteration ${i + 1} of ${iterations}.`);
        showToast(`Generating iteration ${i + 1} of ${iterations}...`, 'info');
        try {
            const result = await generateSlicesWithRetry(userPrompt, state.model);
            const messageContent = result?.choices?.[0]?.message?.content;
            if (messageContent) {
                log(`Iteration ${i+1}: Received content from API. Attempting to parse JSON.`);
                try {
                    const parsedJson = JSON.parse(messageContent);
                    const newSlices = parsedJson?.slices || [];
                    
                    if (Array.isArray(newSlices) && newSlices.length > 0) {
                        log(`Successfully parsed ${newSlices.length} slices from JSON response.`);
                        allSlices.push(...newSlices);
                        const cost = calculateCost(result);
                        totalCost += cost;
                        updateCostTracker(totalCost);
                    } else {
                        log(`[WARNING] Parsed JSON, but it contained no valid slices.`, { parsedJson });
                        showToast(`Warning: Iteration ${i+1} yielded 0 slices.`, 'error');
                    }
                } catch (jsonError) {
                    log(`[ERROR] Failed to parse JSON response from model.`, { error: jsonError.message, content: messageContent });
                    showToast(`Error: Model returned invalid JSON.`, 'error');
                    break;
                }
            } else {
                 log(`[ERROR] Iteration ${i+1}: API response content was empty.`, { response: result });
                 showToast(`Error during iteration ${i+1}: API returned an empty response.`, 'error');
                 break;
            }
        } catch (error) {
            log(`[ERROR] Iteration ${i + 1} failed with an unrecoverable error.`, { error: error.message, status: error.status });
            showToast(`Error during iteration ${i + 1}: ${error.message}`, 'error');
            break; 
        }
    }
    state.slices = allSlices;
    renderResults(state.slices);
    saveToLocalStorage();
    setGeneratingState(false);
    if (allSlices.length > 0) { log(`Generation finished. Total slices generated: ${allSlices.length}`); showToast(`Successfully generated ${allSlices.length} slices.`, 'success'); } 
    else { log(`Generation finished but no slices were generated.`); }
}

async function generateSlicesWithRetry(userPrompt, primaryModel, retries = 3, backoff = 1000) {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }];
    log(`Attempting API call to model: ${primaryModel}. Retries left: ${retries}`);
    try {
        const params = {
            apiKey: state.apiKey,
            model: primaryModel,
            messages,
            max_tokens: 4096,
            temperature: 0.2,
            response_format: { type: "json_object" }
        };
        log('Calling OpenRouter with params:', { model: params.model, max_tokens: params.max_tokens, temperature: params.temperature, response_format: params.response_format });
        const result = await callOpenRouter(params);
        log('API call successful. Received response:', result);
        return result;
    } catch (error) {
        log(`[ERROR] API call failed.`, { status: error.status, message: error.message, data: error.data });
        if ((error.status === 429 || error.status >= 500) && retries > 0) {
            log(`Retrying in ${backoff / 1000}s...`);
            showToast(`Model busy/error. Retrying in ${backoff / 1000}s...`, 'info');
            await new Promise(resolve => setTimeout(resolve, backoff));
            return generateSlicesWithRetry(userPrompt, primaryModel, retries - 1, backoff * 2);
        } else if (primaryModel !== FALLBACK_MODEL) {
            log(`Primary model failed. Trying fallback model: ${FALLBACK_MODEL}`);
            showToast(`Primary model failed. Trying fallback: ${FALLBACK_MODEL}`, 'info');
            return generateSlicesWithRetry(userPrompt, FALLBACK_MODEL, 2);
        } else {
            log('All retries and fallbacks failed. Rethrowing final error.');
            throw error;
        }
    }
}

// --- UI & RENDERING ---

function populateModels() {
    log('Populating models from curated list.');
    elements.modelSelect.innerHTML = '';
    state.models.forEach(model => {
        elements.modelSelect.add(new Option(model.name, model.id));
    });
    elements.modelSelect.value = state.model || DEFAULT_MODEL;
    log(`Populated model dropdown. Defaulted to: ${elements.modelSelect.value}`);
}

function loadFromLocalStorage() {
    const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedData) {
        try {
            const parsed = JSON.parse(savedData);
            log('Session found in localStorage. Applying settings...', parsed);
            state.slices = parsed.slices || [];
            state.description = parsed.description || '';
            elements.descriptionInput.value = state.description;
            
            const savedModel = parsed.model || DEFAULT_MODEL;
            if (state.models.some(m => m.id === savedModel)) {
                elements.modelSelect.value = savedModel;
                state.model = savedModel;
                log(`Successfully set model from localStorage: ${savedModel}`);
            } else {
                log(`[WARNING] Saved model "${savedModel}" not found in curated list. Using current default: ${elements.modelSelect.value}`);
                state.model = elements.modelSelect.value;
            }
            
            if (state.slices.length > 0) { renderResults(state.slices); }
        } catch (e) {
            log('[ERROR] Failed to parse data from localStorage.', { error: e.message });
            localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
    } else {
        log('No previous session found in localStorage.');
    }
}

function calculateCost(result) {
    const modelId = result.model;
    const modelData = state.models.find(m => m.id === modelId);
    if (modelData && modelData.pricing && result.usage) {
        const promptCost = (result.usage.prompt_tokens / 1000000) * (modelData.pricing.prompt || 0);
        const completionCost = (result.usage.completion_tokens / 1000000) * (modelData.pricing.completion || 0);
        const totalCost = promptCost + completionCost;
        log(`Calculated cost for ${modelId}: $${totalCost.toFixed(6)}`, { usage: result.usage, pricing: modelData.pricing });
        return totalCost;
    }
    log(`Could not calculate cost for ${modelId}, missing pricing/usage data.`);
    return 0;
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

function cleanSlices() {
    state.slices = [];
    renderResults([]);
    saveToLocalStorage();
    showToast('Slices cleared!', 'info');
}

function setGeneratingState(isGenerating) {
    state.isGenerating = isGenerating;
    elements.generateBtn.disabled = isGenerating;
    elements.spinner.style.display = isGenerating ? 'block' : 'none';
    elements.btnText.textContent = isGenerating ? 'Generating...' : 'Generate Slices';
    log(`UI state changed: isGenerating = ${isGenerating}`);
}

function toggleAccordion(header) {
    const isExpanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', !isExpanded);
    const content = header.nextElementSibling;
    if (!isExpanded) {
        content.style.maxHeight = content.scrollHeight + 'px';
    } else {
        content.style.maxHeight = '0';
    }
    log(`Accordion toggled to ${!isExpanded ? 'open' : 'closed'}`);
}

function updateCostTracker(totalCost) {
    elements.costTracker.textContent = `Estimated Cost: $${totalCost.toFixed(6)}`;
    elements.costTracker.style.display = 'block';
}

function saveApiKey(key) { state.apiKey = key; localStorage.setItem(API_KEY_STORAGE_KEY, key); log('API key saved to localStorage.'); }
function loadApiKey() { const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY); if (savedKey) { state.apiKey = savedKey; elements.apiKeyInput.value = savedKey; log('API key loaded from localStorage.'); } else { log('No API key found in localStorage.'); } }
function saveToLocalStorage() { const dataToSave = { runDate: new Date().toISOString(), description: state.description, model: state.model, slices: state.slices }; localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(dataToSave)); log('Current session saved to localStorage.'); }

function copyToClipboard(text, successMessage) { navigator.clipboard.writeText(text).then(() => { showToast(successMessage, 'success'); log(`Successfully copied text to clipboard.`, { text: text.substring(0, 100) + '...' }); }).catch(err => { showToast('Failed to copy to clipboard.', 'error'); log('[ERROR] Failed to copy to clipboard.', { error: err.message }); }); }
function copyDebugLog() { copyToClipboard(elements.debugLogContent.textContent, 'Debug log copied!'); }
function copySingleSlice(index) { if (state.slices[index]) { copyToClipboard(state.slices[index].prompt, `Slice ${parseInt(index, 10) + 1} prompt copied!`); } }
function copyAllSlices() { if (state.slices.length === 0) return; const allText = state.slices.map((s, i) => `## Slice ${i + 1} — ${s.title}\n\n\`\`\`\n${s.prompt}\n\`\`\``).join('\n\n---\n\n'); copyToClipboard(allText, 'All slices copied to clipboard!'); }

function downloadFile(content, fileName, contentType) {
    log(`Downloading file: ${fileName}`, { type: contentType });
    const a = document.createElement("a");
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function downloadAsMarkdown() { if (state.slices.length === 0) return; const allText = state.slices.map((s, i) => `## Slice ${i + 1} — ${s.title}\n\n\`\`\`prompt\n${s.prompt}\n\`\`\``).join('\n\n'); downloadFile(allText, 'vertiprompt-slices.md', 'text/markdown'); }
function exportAsJson() { if (state.slices.length === 0) return; const exportData = { schemaVersion: '1.0', runDate: new Date().toISOString(), description: state.description, model: state.model, slices: state.slices }; downloadFile(JSON.stringify(exportData, null, 2), 'vertiprompt-export.json', 'application/json'); }

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    log(`Importing file: ${file.name}`, { size: file.size, type: file.type });
    if (file.size > 200 * 1024) { showToast('File is too large (max 200KB).', 'error'); log('[ERROR] Import failed: File size exceeds 200KB limit.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.schemaVersion !== '1.0' || !Array.isArray(data.slices)) { throw new Error("Invalid or unsupported file format."); }
            state.description = data.description || '';
            state.model = data.model || DEFAULT_MODEL;
            state.slices = data.slices;
            elements.descriptionInput.value = state.description;
            elements.modelSelect.value = state.model;
            renderResults(state.slices);
            saveToLocalStorage();
            showToast('Successfully imported slices!', 'success');
            log('Import successful.');
        } catch (error) {
            log(`[ERROR] Import failed: ${error.message}`);
            showToast(`Import failed: ${error.message}`, 'error');
        } finally {
            elements.toolbar.importJsonInput.value = '';
        }
    };
    reader.readAsText(file);
}

function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.addEventListener('transitionend', () => toast.remove()); }, duration);
}