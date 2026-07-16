/* =============================================================
 * Melissa Personator Search — Lead Update Widget (SMB 3-Step)
 * -------------------------------------------------------------
 * ARCHITECTURE:
 *   Step 1  Search Criteria Widget  (mandatory FN/LN + optional checkboxes)
 *   Step 2  Results Widget          (table + search + pagination + Back)
 *   Step 3  Selected Record Preview (card/grid modal + Update Lead)
 *
 * PRESERVED EXACTLY FROM EXISTING CODE (source of truth):
 *   - Melissa API endpoint / integration / license key handling
 *   - callMelissaSearchAPI() request format + ReturnAllPages:True + SearchConditions:loose
 *   - API response parsing (mapMelissaRecords + all get* helpers)
 *   - Duplicate removal: dedupRawMelissaRecords(), dedupMelissaRows(), MelissaIdentityKey logic
 *   - Merge-results logic
 *   - Zoho CRM update logic, field mappings, buildUpdatePayload(), updateLeadRecord()
 *   - Current Address / Previous Address handling
 *   - Phone / Email extraction logic
 * ============================================================= */

const PERSONATOR_ENDPOINT = "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch";
const PERSONATOR_PROXY_URL = "";
const PERSONATOR_LICENSE_KEY = "NNyQiGBQttkIhzONLxAqXx**";
const ADDRESS_UPDATE_MODE = "separate";
const FIELD_API_NAMES = {
    street: "LOCATION_ADDRESS",
    state: "LOCATION_ADDRESS_STATE",
    city: "LOCATION_ADDRESS_CITY",
    zip: "Home_Address_Zip",
    phone: "Phone",
    email: "Email",
    yearOfBirth: "Year_of_Birth"
};

let sdkReady = false;
let currentLeadId = null;
let currentLeadRecord = null;
let melissaRecords = [];
let filteredRecords = [];
let selectedMelissaRecord = null;
let selectedIndex = -1;
let searchLeadRecord = null;
let baseSearchParams = null;   // built once the lead is loaded

/* ---- pagination state ---- */
const PAGE_SIZE = 5;
let currentPage = 1;

const LEAD_SNAPSHOT_STORAGE_PREFIX = "melissaWidget:leadSearch_V8_:";
function getLeadSnapshotStorageKey(leadId) {
    return LEAD_SNAPSHOT_STORAGE_PREFIX + String(leadId);
}
function loadSavedLeadSearchCriteria(leadId) {
    try {
        const raw = localStorage.getItem(getLeadSnapshotStorageKey(leadId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && "object" === typeof parsed ? parsed : null;
    } catch (e) {
        return null;
    }
}
function persistLeadSearchCriteria(leadId, leadRecord) {
    try {
        const snapshot = {
            First_Name: String(leadRecord?.First_Name || ""),
            Last_Name: String(leadRecord?.Last_Name || ""),
            Full_Name: String(leadRecord?.Full_Name || ""),
            Email: String(leadRecord?.Email || ""),
            Phone: String(leadRecord?.Phone || ""),
            Mobile: String(leadRecord?.Mobile || ""),
            Year_of_Birth: String(leadRecord?.Year_of_Birth || ""),
            Date_of_Birth: String(leadRecord?.Date_of_Birth || ""),
            DOB: String(leadRecord?.DOB || ""),
            Home_Address_Zip: String(leadRecord?.Home_Address_Zip || ""),
            Zip_Code: String(leadRecord?.Zip_Code || ""),
            State: String(leadRecord?.State || leadRecord?.LOCATION_ADDRESS_STATE || leadRecord?.Home_Address_State || "")
        };
        localStorage.setItem(getLeadSnapshotStorageKey(leadId), JSON.stringify(snapshot));
        return snapshot;
    } catch (e) {
        return null;
    }
}

const els = {
    banner: document.getElementById("banner"),

    // step screens
    step1: document.getElementById("step1"),
    step2: document.getElementById("step2"),

    // step 1 fields
    criteriaFirstName: document.getElementById("criteriaFirstName"),
    criteriaLastName: document.getElementById("criteriaLastName"),
    optEmail: document.getElementById("optEmail"),
    optPhone: document.getElementById("optPhone"),
    optPostal: document.getElementById("optPostal"),
    optState: document.getElementById("optState"),
    optDob: document.getElementById("optDob"),
    findDataBtn: document.getElementById("findDataBtn"),

    // step 2
    backBtn: document.getElementById("backBtn"),
    loading: document.getElementById("loadingState"),
    empty: document.getElementById("emptyState"),
    resultsWrap: document.getElementById("resultsWrapper"),
    resultsBody: document.getElementById("resultsBody"),
    filterInput: document.getElementById("filterInput"),
    paginationTotal: document.getElementById("paginationTotal"),
    paginationShowing: document.getElementById("paginationShowing"),
    pageNumbers: document.getElementById("pageNumbers"),
    pagePrevBtn: document.getElementById("pagePrevBtn"),
    pageNextBtn: document.getElementById("pageNextBtn"),

    // step 3 preview modal
    previewSec: document.getElementById("previewSection"),
    previewGrid: document.getElementById("previewGrid"),
    previewCancelBtn: document.getElementById("previewCancelBtn"),
    previewUpdateBtn: document.getElementById("previewUpdateBtn"),

    // proceed / validation popup
    proceedModal: document.getElementById("proceedModal"),
    proceedTitle: document.getElementById("proceedTitle"),
    proceedBody: document.getElementById("proceedBody"),
    proceedCancelBtn: document.getElementById("proceedCancelBtn"),
    proceedConfirmBtn: document.getElementById("proceedConfirmBtn"),

    // success modal
    successModal: document.getElementById("successModal"),
    successClose: document.getElementById("successCloseBtn")
};

function showBanner(message, type = "info") {
    els.banner.textContent = message;
    els.banner.className = `banner banner-${type}`;
}
function hideBanner() {
    els.banner.className = "banner banner-hidden";
    els.banner.textContent = "";
}
function setLoading(isLoading) {
    els.loading.classList.toggle("hidden", !isLoading);
}
function showEmpty(show) {
    els.empty.classList.toggle("hidden", !show);
}
function setEmptyMessage(msg) {
    const p = els.empty.querySelector("p");
    if (p) p.textContent = msg;
}
function showResults(show) {
    els.resultsWrap.classList.toggle("hidden", !show);
}
function showPreview(show) {
    els.previewSec.classList.toggle("hidden", !show);
}
function escapeHtml(str) {
    if (null === str || void 0 === str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

let updateLeadBtn = null;
function refreshUpdateButton() {
    const disabled = !sdkReady || !currentLeadId || !selectedMelissaRecord;
    if (updateLeadBtn) updateLeadBtn.disabled = disabled;
    if (els.previewUpdateBtn) els.previewUpdateBtn.disabled = disabled;
}

/* =============================================================
 * STEP NAVIGATION
 * ============================================================= */
function goToStep1() {
    els.step1.classList.remove("hidden");
    els.step2.classList.add("hidden");
    showPreview(false);
    hideProceedModal();
}
function goToStep2() {
    els.step1.classList.add("hidden");
    els.step2.classList.remove("hidden");
    showPreview(false);
    hideProceedModal();
}

/* =============================================================
 * ZOHO SDK INIT — load lead + prefill Step 1 (NO auto search)
 * ============================================================= */
ZOHO.embeddedApp.on("PageLoad", (async function(data) {
    sdkReady = true;
    try {
        if (ZOHO?.CRM?.UI?.Resize) ZOHO.CRM.UI.Resize({
            height: "1000",
            width: "1900"
        });
    } catch (e) {}

    if (data) {
        if (data.EntityId) currentLeadId = Array.isArray(data.EntityId) ? data.EntityId[0] : data.EntityId;
        else if (data.Entity) currentLeadId = Array.isArray(data.Entity) ? data.Entity[0] : data.Entity;
    }

    if (!currentLeadId) {
        showBanner("Current Lead ID not found.", "error");
        return;
    }

    try {
        currentLeadRecord = await fetchCurrentLead(currentLeadId);
        const savedCriteria = loadSavedLeadSearchCriteria(currentLeadId);
        if (savedCriteria) searchLeadRecord = savedCriteria;
        else searchLeadRecord = persistLeadSearchCriteria(currentLeadId, currentLeadRecord) || currentLeadRecord;

        // build the base params once — used by every subsequent search
        baseSearchParams = buildMelissaSearchParams(searchLeadRecord);

        // prefill mandatory fields from the lead (read-only, cannot be removed)
        els.criteriaFirstName.value = baseSearchParams.first || "";
        els.criteriaLastName.value = baseSearchParams.last || "";

        goToStep1();
    } catch (err) {
        console.error("Widget load error:", err);
        showBanner(`Failed to load lead: ${err.message || err}`, "error");
    }
}));

function hasLicenseError(response) {
    if (!response) return false;
    const tr = String(response.TransmissionResults || "");
    return /\bGE0[5-8]\b/.test(tr) || /\bSE01\b/.test(tr);
}
ZOHO.embeddedApp.init();

async function fetchCurrentLead(leadId) {
    const resp = await ZOHO.CRM.API.getRecord({
        Entity: "Leads",
        RecordID: leadId
    });
    if (resp && resp.data && resp.data.length > 0) return resp.data[0];
    throw new Error("Lead not found in CRM.");
}

function buildMelissaSearchParams(lead) {
    const first = String(lead?.First_Name || "").trim();
    const last = String(lead?.Last_Name || "").trim();
    const fullName = (first + " " + last).trim();
    const birthYear = String(lead?.Year_of_Birth || "").trim();
    return {
        first: first,
        last: last,
        full: fullName,
        state: String(lead?.State || lead?.LOCATION_ADDRESS_STATE || lead?.Home_Address_State || "").trim(),
        postal: String(lead?.Home_Address_Zip || lead?.Zip_Code || "").trim(),
        email: String(lead?.Email || "").trim(),
        phone: String(lead?.Phone || lead?.Mobile || "").trim(),
        birthYear: String(lead?.Year_of_Birth || "").trim() || extractYear(lead?.Date_of_Birth || lead?.DOB)
    };
}

function extractYear(value) {
    if (!value) return "";
    const m = String(value).match(/(19|20)\d{2}/);
    return m ? m[0] : "";
}

function normalizeName(value) { return String(value || "").trim().toLowerCase(); }
function normalizeText(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
function normalizeZip(value) { return String(value || "").replace(/\D/g, "").slice(0, 5); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length > 10 ? digits.slice(-10) : digits;
}

/* ---- MelissaIdentityKey-based duplicate detection (UNCHANGED) ---- */
function getMelissaUniqueKey(record) {
    const mik = record?.MelissaIdentityKey || record?.melissaIdentityKey || "";
    if (mik) return `mik:${String(mik).trim()}`;
    const phones = getMelissaPhoneRecords(record).map(normalizePhone).filter(Boolean).sort().join("|");
    const emails = getMelissaEmailRecords(record).map(normalizeEmail).filter(Boolean).sort().join("|");
    const fullName = record?.FullName || [
        record?.Name?.FirstName || record?.First || "",
        record?.Name?.MiddleName || record?.Middle || "",
        record?.Name?.LastName || record?.Last || ""
    ].map((s => String(s || "").trim())).filter(Boolean).join(" ");
    return [
        "combined",
        normalizeText(fullName),
        String(record?.DateOfBirth || "").trim(),
        normalizeText(record?.CurrentAddress?.AddressLine1 || ""),
        normalizeZip(record?.CurrentAddress?.PostalCode || ""),
        phones,
        emails
    ].join("||");
}

/* ---- dedupRawMelissaRecords (UNCHANGED) ---- */
function dedupRawMelissaRecords(records) {
    if (!Array.isArray(records) || 0 === records.length) return [];
    const uniqueRecordsMap = new Map;
    records.forEach((record => {
        const key = getMelissaUniqueKey(record);
        if (!uniqueRecordsMap.has(key)) uniqueRecordsMap.set(key, record);
    }));
    return Array.from(uniqueRecordsMap.values());
}

/* ---- dedupMelissaRows (UNCHANGED) ---- */
function dedupMelissaRows(rows) {
    const seen = new Set;
    const unique = [];
    rows.forEach((row => {
        const key = [
            String(row.melissaRecordLabel || "").trim(),
            normalizeName(row.firstName),
            normalizeName(row.lastName),
            String(row.birthYear || "").trim(),
            normalizeName(row.dataType),
            normalizeName(row.homeAddressStreet),
            normalizeName(row.homeAddressCity),
            normalizeName(row.homeAddressState),
            normalizeZip(row.homeAddressZip),
            normalizePhone(row.phone),
            normalizeEmail(row.email)
        ].join("|");
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(row);
    }));
    return unique;
}

/* ---- Melissa API call (UNCHANGED: format, ReturnAllPages, loose) ---- */
async function callMelissaSearchAPI(params) {
    const controller = new AbortController;
    const timeoutId = setTimeout((() => controller.abort()), 2e4);
    try {
        let url = PERSONATOR_ENDPOINT + "?id=" + encodeURIComponent(PERSONATOR_LICENSE_KEY) + "&format=JSON&cols=GrpAll,PreviousAddress,DateOfBirth";
        if (params.first) url += "&first=" + encodeURIComponent(params.first);
        if (params.last) url += "&last=" + encodeURIComponent(params.last);
        if (params.full) url += "&full=" + encodeURIComponent(params.full);
        if (params.state) url += "&state=" + encodeURIComponent(params.state);
        if (params.postal) url += "&postal=" + encodeURIComponent(params.postal);
        if (params.email) url += "&email=" + encodeURIComponent(params.email);
        if (params.phone) url += "&phone=" + encodeURIComponent(params.phone);
        if (params.birthYear) url += "&dob=" + encodeURIComponent(params.birthYear);
        url += "&opt=ReturnAllPages:True,SearchConditions:loose";
        console.log("URL Triggered (Masked):", url.replace(/([?&]id=)[^&]+/i, "$1***MASKED***"));
        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`API error ${response.status}`);
        return await response.json();
    } catch (error) {
        if (error && "AbortError" === error.name) throw new Error("Search timed out.");
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/* ---- response-parsing helpers (UNCHANGED) ---- */
function toDisplayString(v) {
    if (null === v || void 0 === v) return "";
    if ("string" === typeof v) return v.trim();
    if ("number" === typeof v || "boolean" === typeof v) return String(v);
    return "";
}
function toRecordArray(value) {
    if (Array.isArray(value)) return value;
    if (null === value || void 0 === value || "" === value) return [];
    return [value];
}
function firstDisplayValue(...values) {
    for (const value of values) {
        const displayValue = toDisplayString(value);
        if (displayValue) return displayValue;
    }
    return "";
}
function getMelissaPhoneRecords(record) {
    const phoneEntries = [
        ...toRecordArray(record?.PhoneRecords),
        ...toRecordArray(record?.Phones),
        ...toRecordArray(record?.PhoneNumbers)
    ];
    if (0 === phoneEntries.length) {
        phoneEntries.push(record?.PhoneNumber, record?.phoneNumber, record?.Phone, record?.phone);
    }
    const seen = new Set;
    const phones = [];
    phoneEntries.forEach((entry => {
        const phone = "string" === typeof entry || "number" === typeof entry
            ? toDisplayString(entry)
            : firstDisplayValue(entry?.phoneNumber, entry?.PhoneNumber, entry?.phone, entry?.Phone, entry?.number, entry?.Number);
        const normalized = normalizePhone(phone);
        if (!phone || !normalized || seen.has(normalized)) return;
        seen.add(normalized);
        phones.push(phone);
    }));
    return phones;
}
function getMelissaEmailRecords(record) {
    const emailEntries = [
        ...toRecordArray(record?.EmailRecords),
        ...toRecordArray(record?.Emails),
        ...toRecordArray(record?.EmailAddresses)
    ];
    if (0 === emailEntries.length) {
        emailEntries.push(record?.EmailAddress, record?.emailAddress, record?.Email, record?.email);
    }
    const seen = new Set;
    const emails = [];
    emailEntries.forEach((entry => {
        const email = "string" === typeof entry
            ? toDisplayString(entry)
            : firstDisplayValue(entry?.email, entry?.Email, entry?.emailAddress, entry?.EmailAddress, entry?.address, entry?.Address);
        const normalized = normalizeEmail(email);
        if (!email || !normalized || seen.has(normalized)) return;
        seen.add(normalized);
        emails.push(email);
    }));
    return emails;
}
function getMelissaCurrentAddress(record) {
    const currentAddress = record?.CurrentAddress || record?.CurrentAddresses || null;
    return Array.isArray(currentAddress) ? currentAddress[0] || null : currentAddress;
}
function getMelissaPreviousAddresses(record) {
    return toRecordArray(record?.PreviousAddresses || record?.PreviousAddressRecords || record?.PreviousAddress)
        .filter((address => address && "object" === typeof address));
}

/* ---- mapMelissaRecords (UNCHANGED: current/previous address handling) ---- */
function mapMelissaRecords(records) {
    if (!Array.isArray(records) || 0 === records.length) return [];
    const snapshotForLabels = searchLeadRecord || currentLeadRecord || {};
    const leadPhone = normalizePhone(snapshotForLabels.Phone || snapshotForLabels.Mobile || "");
    const leadEmail = normalizeEmail(snapshotForLabels.Email || "");
    const rows = [];
    records.forEach(((record, recordIndex) => {
        const groupLabel = `Person #${recordIndex + 1}`;
        const firstName = firstDisplayValue(record?.FirstName, record?.Name?.FirstName, record?.First);
        const middleName = firstDisplayValue(record?.MiddleName, record?.Name?.MiddleName, record?.Middle);
        const lastName = firstDisplayValue(record?.LastName, record?.Name?.LastName, record?.Last);
        const birthYear = extractYear(record?.DateOfBirth);
        const currentAddress = getMelissaCurrentAddress(record);
        const previousAddresses = getMelissaPreviousAddresses(record);
        const allPhones = getMelissaPhoneRecords(record);
        const allEmails = getMelissaEmailRecords(record);
        const blankRow = {
            melissaRecordLabel: groupLabel,
            firstName, middleName, lastName, birthYear,
            dataType: "", homeAddressStreet: "", homeAddressState: "",
            homeAddressCity: "", homeAddressZip: "", phone: "", email: ""
        };
        const buildAddressRow = (addr, label, phoneStr, emailStr) => ({
            ...blankRow,
            dataType: label,
            homeAddressStreet: firstDisplayValue(addr?.AddressLine1, addr?.Street, addr?.Address1),
            homeAddressState: firstDisplayValue(addr?.State, addr?.StateProvince, addr?.Province),
            homeAddressCity: firstDisplayValue(addr?.City, addr?.Locality),
            homeAddressZip: firstDisplayValue(addr?.PostalCode, addr?.ZipCode, addr?.Zip, addr?.Postal),
            phone: toDisplayString(phoneStr),
            email: toDisplayString(emailStr)
        });
        const workingPhones = [...allPhones];
        const workingEmails = [...allEmails];
        let currentPhone = "";
        let currentEmail = "";
        if (currentAddress) {
            currentPhone = leadPhone && allPhones.find((phone => normalizePhone(phone) === leadPhone)) || allPhones[0] || "";
            currentEmail = leadEmail && allEmails.find((email => normalizeEmail(email) === leadEmail)) || allEmails[0] || "";
            if (currentPhone) {
                const phoneIndex = workingPhones.findIndex((phone => normalizePhone(phone) === normalizePhone(currentPhone)));
                if (-1 !== phoneIndex) workingPhones.splice(phoneIndex, 1);
            }
            if (currentEmail) {
                const emailIndex = workingEmails.findIndex((email => normalizeEmail(email) === normalizeEmail(currentEmail)));
                if (-1 !== emailIndex) workingEmails.splice(emailIndex, 1);
            }
            rows.push(buildAddressRow(currentAddress, "Current Address", currentPhone, currentEmail));
        }
        previousAddresses.forEach(((address, index) => {
            rows.push(buildAddressRow(address, "Previous Address", workingPhones[index] || "", workingEmails[index] || ""));
        }));
        const extraPhones = workingPhones.slice(previousAddresses.length);
        const extraEmails = workingEmails.slice(previousAddresses.length);
        const additionalCount = Math.max(extraPhones.length, extraEmails.length);
        for (let index = 0; index < additionalCount; index++) {
            const phone = extraPhones[index] || "";
            const email = extraEmails[index] || "";
            if (!phone && !email) continue;
            rows.push({ ...blankRow, dataType: "Additional Contact", phone, email });
        }
    }));
    return rows;
}

/* =============================================================
 * STEP 1 — SEARCH CRITERIA + VALIDATION + SEARCH EXECUTION
 * ============================================================= */

/** Which optional checkboxes are currently ticked. */
function getSelectedOptionalFields() {
    const selected = [];
    if (els.optEmail.checked)  selected.push("email");
    if (els.optPhone.checked)  selected.push("phone");
    if (els.optPostal.checked) selected.push("postal");
    if (els.optState.checked)  selected.push("state");
    if (els.optDob.checked)    selected.push("birthYear");
    return selected;
}

const FIELD_LABELS = {
    email: "Email",
    phone: "Phone",
    postal: "Postal / ZIP Code",
    state: "State",
    birthYear: "Date of Birth / Year of Birth"
};

/** Does the lead actually hold data for this optional field? */
function leadHasField(field) {
    if (!baseSearchParams) return false;
    const val = baseSearchParams[field];
    return !!(val && String(val).trim());
}

/** Build one Melissa search attempt per available selected field (FN+LN+X). */
function buildSearchAttempts(availableFields) {
    const first = baseSearchParams.first;
    const last = baseSearchParams.last;
    const attempts = [];

    if (availableFields.length === 0) {
        // no optional field → FN + LN only
        attempts.push({ label: "first + last", params: { first, last } });
        return attempts;
    }

    availableFields.forEach((field) => {
        const params = { first, last };
        params[field] = baseSearchParams[field];
        attempts.push({ label: `first + last + ${field}`, params });
    });
    return attempts;
}

/** Find Data click → validate → (maybe popup) → search. */
async function handleFindData() {
    if (!baseSearchParams || !baseSearchParams.first || !baseSearchParams.last) {
        showBanner("First Name and Last Name are required on the Lead.", "error");
        return;
    }

    const selected = getSelectedOptionalFields();
    const available = selected.filter(leadHasField);
    const missing = selected.filter((f) => !leadHasField(f));

    if (missing.length > 0) {
        // Missing-data validation popup (Scenario 1 / 2 / 3)
        showProceedModal(missing, available, () => runSearch(available));
        return;
    }

    // everything selected is available (or nothing selected) → search directly
    runSearch(available);
}

/** Execute the search ladder, merge, dedup, render Step 2. */
async function runSearch(availableFields) {
    hideProceedModal();
    hideBanner();
    goToStep2();

    // reset result state
    melissaRecords = [];
    filteredRecords = [];
    selectedMelissaRecord = null;
    selectedIndex = -1;
    currentPage = 1;
    els.filterInput.value = "";
    els.filterInput.disabled = true;
    showResults(false);
    showEmpty(false);
    setLoading(true);

    try {
        const searchAttempts = buildSearchAttempts(availableFields);
        const allRecords = [];
        let licenseIssueDetected = false;

        for (const attempt of searchAttempts) {
            console.log(`Running Attempt: ${attempt.label}`, attempt.params);
            let rawResponse = null;
            try {
                rawResponse = await callMelissaSearchAPI(attempt.params);
            } catch (attemptErr) {
                console.error(`Attempt "${attempt.label}" failed:`, attemptErr);
                continue;
            }
            if (hasLicenseError(rawResponse)) { licenseIssueDetected = true; break; }
            const recs = Array.isArray(rawResponse?.Records) ? rawResponse.Records : [];
            allRecords.push(...recs); // ---- merge results ----
        }

        if (licenseIssueDetected) {
            setLoading(false);
            setEmptyMessage("Melissa license key issue.");
            showEmpty(true);
            return;
        }

        // ---- duplicate removal (existing logic) ----
        const matchedRaw = dedupRawMelissaRecords(allRecords);
        setLoading(false);

        if (0 === matchedRaw.length) {
            setEmptyMessage("No records found for the selected criteria.");
            showEmpty(true);
            return;
        }

        const flattenedMelissaRows = mapMelissaRecords(matchedRaw);
        const uniqueRows = dedupMelissaRows(flattenedMelissaRows);

        if (0 === uniqueRows.length) {
            setEmptyMessage("No valid address records found to display.");
            showEmpty(true);
            return;
        }

        melissaRecords = uniqueRows.map((r => Object.freeze({ ...r })));
        filteredRecords = melissaRecords.slice();
        currentPage = 1;

        renderResults(filteredRecords);
        showResults(true);
        els.filterInput.disabled = false;
    } catch (err) {
        console.error("Search error:", err);
        setLoading(false);
        showBanner(`Failed to load results: ${err.message || err}`, "error");
        showEmpty(true);
    }
}

/* ---- Missing-data validation popup (Scenarios 1/2/3) ---- */
let proceedCallback = null;

function showProceedModal(missing, available, onProceed) {
    proceedCallback = onProceed;

    const missingList = missing.map((f) => `<li class="missing">${escapeHtml(FIELD_LABELS[f])}</li>`).join("");

    let title, bodyHtml;
    if (available.length === 0) {
        // Scenario 1 (single) or Scenario 3 (all) blank → proceed with FN + LN only
        title = missing.length === 1
            ? `${FIELD_LABELS[missing[0]]} is not available on this Lead record.`
            : "The following selected fields are not available:";
        bodyHtml = `
            ${missing.length > 1 ? `<ul>${missingList}</ul>` : ""}
            <div>Would you like to proceed using <strong>First Name and Last Name only?</strong></div>
        `;
    } else {
        // Scenario 2 → some blank; continue with FN + LN + available fields
        const continueList = ["First Name", "Last Name", ...available.map((f) => FIELD_LABELS[f])]
            .map((l) => `<li>${escapeHtml(l)}</li>`).join("");
        title = "The following selected fields are not available:";
        bodyHtml = `
            <ul>${missingList}</ul>
            <div>Would you like to continue using:</div>
            <ul>${continueList}</ul>
        `;
    }

    els.proceedTitle.innerHTML = title;
    els.proceedBody.innerHTML = bodyHtml;
    els.proceedModal.classList.remove("hidden");
}

function hideProceedModal() {
    els.proceedModal.classList.add("hidden");
    proceedCallback = null;
}

/* =============================================================
 * STEP 2 — RESULTS RENDERING + PAGINATION
 * ============================================================= */

function getTotalPages() {
    return Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
}

function renderResults(records) {
    els.resultsBody.innerHTML = "";
    if (!records.length) {
        showEmpty(true);
        showResults(false);
        renderPagination();
        return;
    }
    showEmpty(false);
    showResults(true);

    const totalPages = getTotalPages();
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRecords = records.slice(start, start + PAGE_SIZE);

    let prevGroup = null;
    pageRecords.forEach(((rec, i) => {
        const index = start + i; // absolute index in filteredRecords
        const tr = document.createElement("tr");
        tr.dataset.index = index;
        tr.dataset.melissaRecord = rec.melissaRecordLabel || "";
        if (rec.melissaRecordLabel && rec.melissaRecordLabel !== prevGroup) {
            tr.style.borderTop = "2px solid #c5cee0";
            tr.style.backgroundColor = "#f5f8fc";
            prevGroup = rec.melissaRecordLabel;
        }
        tr.innerHTML = `
        <td>${escapeHtml(rec.melissaRecordLabel) || "—"}</td>
        <td>${escapeHtml(rec.firstName) || "—"}</td>
        <td>${escapeHtml(rec.middleName) || "—"}</td>
        <td>${escapeHtml(rec.lastName) || "—"}</td>
        <td>${escapeHtml(rec.birthYear) || "—"}</td>
        <td>${escapeHtml(rec.dataType) || "—"}</td>
        <td>${escapeHtml(rec.homeAddressStreet) || "—"}</td>
        <td>${escapeHtml(rec.homeAddressState) || "—"}</td>
        <td>${escapeHtml(rec.homeAddressCity) || "—"}</td>
        <td>${escapeHtml(rec.homeAddressZip) || "—"}</td>
        <td>${escapeHtml(rec.phone) || "—"}</td>
        <td>${escapeHtml(rec.email) || "—"}</td>
        <td class="action-cell">
          <button class="btn btn-select" data-action="select" data-index="${index}">Select</button>
        </td>
      `;
        tr.addEventListener("click", (() => selectRecord(index)));
        els.resultsBody.appendChild(tr);
    }));

    if (selectedIndex >= 0) markSelectedRow(selectedIndex);
    renderPagination();
}

function renderPagination() {
    const total = filteredRecords.length;
    const totalPages = getTotalPages();
    if (currentPage > totalPages) currentPage = totalPages;

    els.paginationTotal.textContent = `Total Records: ${total}`;

    if (total === 0) {
        els.paginationShowing.textContent = "Showing 0 to 0 of 0";
        els.pageNumbers.innerHTML = "";
        els.pagePrevBtn.disabled = true;
        els.pageNextBtn.disabled = true;
        return;
    }

    const start = (currentPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(currentPage * PAGE_SIZE, total);
    els.paginationShowing.textContent = `Showing ${start} to ${end} of ${total}`;

    els.pageNumbers.innerHTML = "";
    for (let p = 1; p <= totalPages; p++) {
        const btn = document.createElement("button");
        btn.className = "btn btn-page" + (p === currentPage ? " active" : "");
        btn.textContent = String(p);
        btn.addEventListener("click", () => { currentPage = p; renderResults(filteredRecords); });
        els.pageNumbers.appendChild(btn);
    }

    els.pagePrevBtn.disabled = currentPage <= 1;
    els.pageNextBtn.disabled = currentPage >= totalPages;
}

els.pagePrevBtn.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderResults(filteredRecords); }
});
els.pageNextBtn.addEventListener("click", () => {
    if (currentPage < getTotalPages()) { currentPage++; renderResults(filteredRecords); }
});

function selectRecord(index) {
    const record = filteredRecords[index];
    if (!record) return;
    if (selectedIndex === index) {
        selectedIndex = -1;
        selectedMelissaRecord = null;
        markSelectedRow(-1);
        showPreview(false);
        refreshUpdateButton();
        return;
    }
    selectedIndex = index;
    selectedMelissaRecord = record;
    markSelectedRow(index);
    renderPreview(record);
    showPreview(true);   // opens Step 3 modal
    refreshUpdateButton();
}

function markSelectedRow(index) {
    const rows = els.resultsBody.querySelectorAll("tr");
    rows.forEach((row => {
        const isSel = parseInt(row.dataset.index, 10) === index;
        row.classList.toggle("selected", isSel);
        const btn = row.querySelector(".btn-select");
        if (btn) {
            btn.classList.toggle("is-selected", isSel);
            btn.textContent = isSel ? "Selected" : "Select";
        }
    }));
}

/* =============================================================
 * STEP 3 — PREVIEW (card/grid, exact field order)
 * ============================================================= */
function renderPreview(rec) {
    const fields = [
        ["Melissa Record", rec.melissaRecordLabel],
        ["First Name", rec.firstName],
        ["Middle Name", rec.middleName],
        ["Last Name", rec.lastName],
        ["Year of Birth", rec.birthYear],
        ["Data Type", rec.dataType],
        ["Home Address Street", rec.homeAddressStreet],
        ["Home Address State", rec.homeAddressState],
        ["Home Address City", rec.homeAddressCity],
        ["Home Address Zip", rec.homeAddressZip],
        ["Phone", rec.phone],
        ["Email", rec.email]
    ];
    els.previewGrid.innerHTML = fields.map((([label, value]) => `<div class="preview-item">
            <span class="preview-label">${escapeHtml(label)}</span>
            <span class="preview-value ${value ? "" : "empty"}">${value ? escapeHtml(value) : "—"}</span>
          </div>`)).join("");
}

/* =============================================================
 * GLOBAL SEARCH (Step 2 search box) — UNCHANGED logic, resets page
 * ============================================================= */
const GLOBAL_SEARCH_FIELDS = [
    "melissaRecordLabel", "firstName", "middleName", "lastName", "birthYear",
    "dataType", "homeAddressStreet", "homeAddressState", "homeAddressCity",
    "homeAddressZip", "phone", "email"
];
function normalizeGlobalSearchValue(value) {
    return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/\s+/g, " ").trim();
}
function compactGlobalSearchValue(value) {
    return normalizeGlobalSearchValue(value).replace(/[^a-z0-9]/g, "");
}
function getGlobalSearchValues(record) {
    const firstName = record?.firstName ?? "";
    const middleName = record?.middleName ?? "";
    const lastName = record?.lastName ?? "";
    const fullName = [firstName, middleName, lastName].map((v => String(v ?? "").trim())).filter(Boolean).join(" ");
    const firstAndLastName = [firstName, lastName].map((v => String(v ?? "").trim())).filter(Boolean).join(" ");
    return [...GLOBAL_SEARCH_FIELDS.map((f => record?.[f] ?? "")), fullName, firstAndLastName];
}
function recordMatchesGlobalSearch(record, query) {
    const normalizedQuery = normalizeGlobalSearchValue(query);
    if (!normalizedQuery) return true;
    const searchableValues = getGlobalSearchValues(record);
    const normalizedValues = searchableValues.map((v => normalizeGlobalSearchValue(v))).filter(Boolean);
    const combinedSearchText = normalizedValues.join(" ");
    const compactQuery = compactGlobalSearchValue(query);
    const compactCombinedSearchText = compactGlobalSearchValue(combinedSearchText);
    const queryDigits = /[a-z]/i.test(normalizedQuery) ? "" : String(query ?? "").replace(/\D/g, "");
    if (normalizedValues.some((v => v.includes(normalizedQuery)))) return true;
    if (combinedSearchText.includes(normalizedQuery)) return true;
    if (compactQuery && compactCombinedSearchText.includes(compactQuery)) return true;
    if (queryDigits) {
        return searchableValues.some((v => String(v ?? "").replace(/\D/g, "").includes(queryDigits)));
    }
    return false;
}
function applyGlobalSearch(query) {
    const completeDataset = Array.isArray(melissaRecords) ? melissaRecords : [];
    filteredRecords = completeDataset.filter((record => recordMatchesGlobalSearch(record, query)));
    selectedIndex = -1;
    selectedMelissaRecord = null;
    currentPage = 1;
    showPreview(false);
    refreshUpdateButton();
    renderResults(filteredRecords);
}
els.filterInput.addEventListener("input", (e => { applyGlobalSearch(e.target.value || ""); }));

/* =============================================================
 * CRM UPDATE (UNCHANGED logic, field mappings, payload builder)
 * ============================================================= */
function attachUpdateLeadHandler() {
    updateLeadBtn = document.getElementById("updateLeadBtn");
    if (updateLeadBtn) {
        updateLeadBtn.addEventListener("click", (async function() { await updateLeadRecord(); }));
    }
}
if ("loading" === document.readyState) {
    document.addEventListener("DOMContentLoaded", attachUpdateLeadHandler);
} else {
    attachUpdateLeadHandler();
}

async function updateLeadRecord() {
    if (!sdkReady || !currentLeadId || !selectedMelissaRecord) {
        showBanner("Error: Missing selection.", "error");
        return;
    }
    const updateSnapshot = {
        homeAddressStreet: String(selectedMelissaRecord.homeAddressStreet || ""),
        homeAddressState: String(selectedMelissaRecord.homeAddressState || ""),
        homeAddressCity: String(selectedMelissaRecord.homeAddressCity || ""),
        homeAddressZip: String(selectedMelissaRecord.homeAddressZip || ""),
        phone: String(selectedMelissaRecord.phone || ""),
        email: String(selectedMelissaRecord.email || ""),
        yearOfBirth: String(selectedMelissaRecord.birthYear || "")
    };
    hideBanner();
    if (updateLeadBtn) { updateLeadBtn.disabled = true; updateLeadBtn.textContent = "Updating..."; }
    if (els.previewUpdateBtn) { els.previewUpdateBtn.disabled = true; els.previewUpdateBtn.textContent = "Updating..."; }
    try {
        const updatePayload = buildUpdatePayload(currentLeadId, updateSnapshot);
        const updateResponse = await ZOHO.CRM.API.updateRecord({ Entity: "Leads", APIData: updatePayload });
        showPreview(false);
        selectedIndex = -1;
        selectedMelissaRecord = null;
        markSelectedRow(-1);
        refreshUpdateButton();
        const success = "SUCCESS" === updateResponse?.data?.[0]?.code || "success" === updateResponse?.data?.[0]?.status;
        if (!success) throw new Error(updateResponse?.data?.[0]?.message || "Zoho update failed.");
        showSuccessModal("Record updated successfully");
    } catch (error) {
        showBanner("Update failed: " + (error.message || error), "error");
    } finally {
        if (updateLeadBtn) { updateLeadBtn.disabled = false; updateLeadBtn.textContent = "Update Lead"; }
        if (els.previewUpdateBtn) els.previewUpdateBtn.textContent = "Update Lead";
        refreshUpdateButton();
    }
}

function buildUpdatePayload(leadId, rec) {
    const yobStr = String(rec.yearOfBirth || "").trim();
    const yobNum = /^\d{4}$/.test(yobStr) ? Number(yobStr) : null;
    if ("compound" === ADDRESS_UPDATE_MODE) {
        const payload = { id: leadId };
        const homeAddress = {};
        if (rec.homeAddressStreet) homeAddress.Street = rec.homeAddressStreet;
        if (rec.homeAddressState) homeAddress.State = rec.homeAddressState;
        if (rec.homeAddressCity) homeAddress.City = rec.homeAddressCity;
        if (rec.homeAddressZip) homeAddress.Zip = rec.homeAddressZip;
        if (Object.keys(homeAddress).length) payload.Home_Address = homeAddress;
        if (rec.phone) payload[FIELD_API_NAMES.phone] = rec.phone;
        if (rec.email) payload[FIELD_API_NAMES.email] = rec.email;
        if (null !== yobNum) payload[FIELD_API_NAMES.yearOfBirth] = yobNum;
        return payload;
    }
    const updatePayload = { id: leadId };
    if (rec.homeAddressStreet) updatePayload[FIELD_API_NAMES.street] = rec.homeAddressStreet;
    if (rec.homeAddressState) updatePayload[FIELD_API_NAMES.state] = rec.homeAddressState;
    if (rec.homeAddressCity) updatePayload[FIELD_API_NAMES.city] = rec.homeAddressCity;
    if (rec.homeAddressZip) updatePayload[FIELD_API_NAMES.zip] = rec.homeAddressZip;
    if (rec.phone) updatePayload[FIELD_API_NAMES.phone] = rec.phone;
    if (rec.email) updatePayload[FIELD_API_NAMES.email] = rec.email;
    if (null !== yobNum) updatePayload[FIELD_API_NAMES.yearOfBirth] = yobNum;
    return updatePayload;
}

function showSuccessModal(message) {
    const modal = document.getElementById("successModal");
    if (!modal) { alert(message || "Record updated successfully"); return; }
    const msgEl = document.getElementById("successMessage") || modal.querySelector(".success-message, .modal-message, h3, p");
    if (msgEl) msgEl.textContent = message || "Record updated successfully";
    modal.classList.remove("hidden");
    modal.style.display = "flex";
}

/* =============================================================
 * EVENT WIRING
 * ============================================================= */

// Step 1 → Find Data
els.findDataBtn.addEventListener("click", handleFindData);

// Step 2 → Back → Step 1
els.backBtn.addEventListener("click", goToStep1);

// Proceed popup buttons
els.proceedCancelBtn.addEventListener("click", () => {
    hideProceedModal();
    goToStep1();          // Cancel → return to Step 1, no search
});
els.proceedConfirmBtn.addEventListener("click", () => {
    const cb = proceedCallback;
    hideProceedModal();
    if (typeof cb === "function") cb();   // Proceed → run search
});

// Step 3 Cancel → close preview, return to Step 2 results list
if (els.previewCancelBtn) {
    els.previewCancelBtn.addEventListener("click", (function() {
        selectedIndex = -1;
        selectedMelissaRecord = null;
        markSelectedRow(-1);
        showPreview(false);
        refreshUpdateButton();
    }));
}

// Step 3 Update Lead
if (els.previewUpdateBtn) {
    els.previewUpdateBtn.addEventListener("click", (async function() { await updateLeadRecord(); }));
}

// Success modal close
if (els.successClose) els.successClose.addEventListener("click", closeWidget);

function closeWidget() {
    try {
        ZOHO.CRM.UI.Popup.closeReload().catch((() => {
            if (ZOHO.CRM.UI.Popup.close) ZOHO.CRM.UI.Popup.close();
        }));
    } catch (e) {}
}
