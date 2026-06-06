
const DB_NAME = 'SRSReviewDB';
const STORE_NAME = 'decks';
const SRS_INTERVALS = [
    5,                 // Level 0: 5m
    60,                // Level 1: 1h
    3 * 60,            // Level 2: 3h
    9 * 60,            // Level 3: 9h
    // This generates 1d, 2d, 3d... up to 29d
    ...Array.from({ length: 29 }, (_, i) => (i + 1) * 24 * 60)
];

let isUpdating = false;
let db;
let editingId = null;
let editingCardIndex = null; // To track which card we are fixing
let currentDeckId = null;
let currentDeck = null;

console.log("🚀 scripts.js: Start of file reached.");
console.log("Checking environment...", {
    dbInitialized: typeof db !== 'undefined',
    storeName: STORE_NAME
});

let currentChunkStart = 0; // Index of the start of the current chunk
let chunkIndex = 0;        // Current card within the chunk (0 to chunkSize-1)
let chunkSize = 20;

let reviewCards = [];      // The active order for the current session
let originalCards = [];    // Master copy of the deck's default order
let isShuffled = false;    // Toggle state

let flashedChunks = []; // Tracks starting indices of yellow chunks

let currentDueCards = [];
let srsModalIndex = 0;
let srsTotalSessionCount = 0;

let recallQueue = [];
let recallIndex = 0;
let recallCorrectIdx = 0;

let matchQueue = [];      // Full list of cards to match
let currentMatchSet = []; // The 4 (or fewer) cards currently on screen
let activeMatchIdx = 0;   // The index of the currently selected question (0-3)

let srsCompletedInSession = 0;
let currentFontSizeLevel = 1; // 0: Small, 1: Medium (Default), 2: Large, 3: Extra Large

let todayIdx = 0;
let todayCards = [];
let showingTodayDetail = false;
window.todaysCardsList = [];

let currentListPage = 0;
const cardsPerPage = 50; // Performance sweet spot for mobile
let displayCards = []; // The actual array we are currently viewing

let currentCorrectIndex = 0;

// --- Database Setup ---
const request = indexedDB.open(DB_NAME, 1);

request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    }
};

request.onsuccess = (e) => {
    db = e.target.result;

    renderDecks();
};

function changeFontSize(delta) {
    // Keep level between 0 and 3
    currentFontSizeLevel = Math.min(3, Math.max(0, currentFontSizeLevel + delta));
    
    // Adjusted size scaling for balance
    const sizes = ['16px', '20px', '26px', '34px'];
    const newSize = sizes[currentFontSizeLevel];
    
    // Comprehensive list of IDs across all modes
    const targetIds = [
        'srsQ', 'srsA', 'srsP', 'srsN',      // SRS Modal
        'revQ', 'revA', 'revP', 'revN',      // Standard Review
        'editP', 'editN',                    // Edit Modal
        'cardPhrase', 'cardNotes'            // Fallback
    ];
    
    targetIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.setProperty('font-size', newSize, 'important');
            
            // Force children to match (overrides inline styles from paste/edit)
            const children = el.querySelectorAll('*');
            children.forEach(child => {
                child.style.setProperty('font-size', newSize, 'important');
            });
        }
    });
    
    // Save to local storage so it persists
    localStorage.setItem('autocard_font_size_level', currentFontSizeLevel);
}

// Add this to your renderSRSModalCard() bottom so it persists across cards
function applySavedFontSize() {
    const saved = localStorage.getItem('autocard_font_size_level');
    if (saved !== null) {
        currentFontSizeLevel = parseInt(saved);
        changeFontSize(0); // Apply current level
    }
}
// --- Deck Management ---
function renderDecks() {
    const container = document.getElementById('deckContainer');
    if (!db || !container) return;
    
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.getAll();

    getRequest.onsuccess = () => {
        container.innerHTML = ''; // Clears the list
        const now = Date.now();
        
        // 1. Calculate the end of the current day (11:59:59 PM)
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);
        const endOfTodayTs = endOfToday.getTime();

        const allDecks = getRequest.result;

        allDecks.forEach(deck => {
            // 2. Calculate Due Now (Red Badge)
            const dueCount = deck.cards ? deck.cards.filter(c => 
                c.srs && !c.srs.mastered && now >= (c.srs.nextReview || 0)
            ).length : 0;

            // 3. Calculate Remaining for Today (Blue Badge)
            // Filter: Scheduled after NOW but before MIDNIGHT
            const pendingTodayCount = deck.cards ? deck.cards.filter(c => 
                c.srs && !c.srs.mastered && 
                (c.srs.nextReview || 0) > now && 
                (c.srs.nextReview || 0) <= endOfTodayTs
            ).length : 0;

            const div = document.createElement('div');
            div.className = 'deck-item';
            div.style.position = 'relative'; 
            div.onclick = () => openDeckDetail(deck.id, deck.name);
            
            div.innerHTML = `
                <span>${deck.name}</span>
                <div>
                    <button onclick="event.stopPropagation(); openAddDeckModal(${deck.id}, '${deck.name.replace(/'/g, "\\'")}')">Rename</button>
                    <button class="btn-delete" onclick="event.stopPropagation(); deleteDeck(${deck.id})">Delete</button>
                </div>

                <div class="list-srs-badge" style="
                    position: absolute;
                    top: -5px;
                    right: -5px;
                    background: #ff4444;
                    color: white;
                    border-radius: 50%;
                    width: 20px;
                    height: 20px;
                    display: ${dueCount > 0 ? 'flex' : 'none'};
                    align-items: center;
                    justify-content: center;
                    font-size: 10px;
                    font-weight: bold;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    z-index: 6;
                    pointer-events: none;
                ">
                    ${dueCount}
                </div>

                <div class="list-postponed-badge" style="
                    position: absolute;
                    top: -5px;
                    right: 18px; 
                    background: #3498db;
                    color: white;
                    border-radius: 50%;
                    width: 20px;
                    height: 20px;
                    display: ${pendingTodayCount > 0 ? 'flex' : 'none'};
                    align-items: center;
                    justify-content: center;
                    font-size: 10px;
                    font-weight: bold;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    z-index: 5;
                    pointer-events: none;
                ">
                    ${pendingTodayCount}
                </div>
            `;
            container.appendChild(div);
        });
    };
}

function updateDeckStats(deck) {
    const now = Date.now();
    if (!deck || !deck.cards) return;

    // We keep the postponed logic only to decide if the Force Load button shows up
    const postponed = deck.cards.filter(c => 
        c.srs && !c.srs.mastered && 
        (c.srs.nextReview > now && c.srs.nextReview <= (now + 5400000))
    );

    // --- LEAVE THE LABEL TO THE MASTER FUNCTION ---
    if (typeof updateSRSBadge === "function") {
        updateSRSBadge(); 
    }

    // Keep the Force Load button toggle logic
    const forceBtn = document.querySelector('button[onclick="startSRSReview(true)"]');
    if (forceBtn) {
        forceBtn.style.display = postponed.length > 0 ? 'block' : 'none';
    }
}

function openDeckDetail(id, name) {
    currentDeckId = id;
    document.getElementById('currentDeckTitle').innerText = name;

    recallQueue = [];
    matchQueue = [];
    window.todaysCardsList = [];

    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
        const deck = request.result;
        if (!deck) return;

        currentDeck = deck; 
        reviewCards = deck.cards || [];

        const now = Date.now();
        const startOfTodayTs = new Date().setHours(0, 0, 0, 0);

        // --- DEBUG VARIABLES ---
        let totalProcessed = 0;
        let srsFound = 0;

        const reviewedToday = reviewCards.filter(c => {
            if (!c.srs) return false;

            // If the card has a lastReview timestamp, use it.
            // If it doesn't, it definitely wasn't reviewed 'today' in this session.
            const lastTouch = c.srs.lastReview || 0;

            return lastTouch >= startOfTodayTs;
        });
        
        window.todaysCardsList = reviewedToday; 

        // --- IPHONE VISUAL DEBUG ---
        // This will pop up on your phone to tell us what's happening
        if (window.todaysCardsList.length > 500) {
            alert(`DEBUG:\nTotal Cards: ${totalProcessed}\nCards with SRS: ${srsFound}\nFiltered Today: ${window.todaysCardsList.length}\n\nLogic error: Filter is too broad!`);
        }

        const trBtn = document.getElementById('todaysReviewBtn');
        const trSub = document.getElementById('todaysCountSub');
        
        if (trBtn && trSub) {
            const tCount = window.todaysCardsList.length;
            // High count safety: hide if it looks like the whole deck
            if (tCount > 0 && tCount < (reviewCards.length - 10)) {
                trBtn.style.display = 'block';
                trSub.innerText = `Reviewed Today: ${tCount} Cards`;
            } else {
                trBtn.style.display = 'none';
                trSub.innerText = ""; 
            }
        }

        updateDeckStats(deck);

        // Session recovery with deduplication
        if (deck.session) {
            const uniqueRecall = new Map();
            (deck.session.recallQueue || []).forEach(c => { if(c.question) uniqueRecall.set(c.question, c) });
            recallQueue = Array.from(uniqueRecall.values());

            const uniqueMatch = new Map();
            (deck.session.matchQueue || []).forEach(c => { if(c.question) uniqueMatch.set(c.question, c) });
            matchQueue = Array.from(uniqueMatch.values());

            currentChunkStart = deck.session.currentChunkStart || 0;
            chunkIndex = deck.session.chunkIndex || 0;
            chunkSize = deck.session.chunkSize || 20;
        }

        updateReviewUI();
        
        document.getElementById('view-list').style.display = 'none';
        document.getElementById('view-detail').style.display = 'block';
    };
}
// Change to async function
async function showListView() {
    console.log("📤 Exiting deck. Saving progress...");
    
    if (currentDeckId) {
        await saveSession();
    }

    // RESET THE FLAG HERE
    window.isReadOnlyReview = false;

    currentDeckId = null;
    document.getElementById('view-list').style.display = 'block';
    document.getElementById('view-detail').style.display = 'none';
    document.getElementById('view-review').style.display = 'none';
    
    renderDecks();
}

function exitReviewToDetail() {
    // 1. Save progress before leaving
    window.currentViewMode = "none";
    saveSession();

    // 2. Hide the review session
    document.getElementById('view-review').style.display = 'none';
    
    // 3. Show the deck detail screen
    document.getElementById('view-detail').style.display = 'block';

    // 4. THE FIX: Refresh BOTH buttons immediately
    // This ensures "Remaining" and "Next: 10m (3)" are updated instantly
    updateReviewUI();
}
function openAddDeckModal(id = null, name = "") {
    editingId = id;
    document.getElementById('modalTitle').innerText = id ? "Rename Deck" : "New Deck";
    document.getElementById('deckInput').value = name;
    document.getElementById('deckModal').style.display = 'flex';
}

function closeDeckModal() {
    document.getElementById('deckModal').style.display = 'none';
    editingId = null;
}


function saveSession(specificCard = null) {
    return new Promise((resolve, reject) => {
        // IF we are in Read-Only mode, do not save anything to IndexedDB
        if (window.isReadOnlyReview) {
            console.log("🛡️ Read-Only Session: Skipping DB Save.");
            resolve();
            return;
        }
        if (!currentDeckId) { 
            resolve(); 
            return; 
        }

        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(currentDeckId);

        getReq.onsuccess = () => {
            const deck = getReq.result;
            if (!deck) { 
                resolve(); 
                return; 
            }

            // --- 1. PRIORITY: SINGLE CARD UPDATE ---
            if (specificCard) {
                const master = deck.cards.find(c => c.id === specificCard.id);
                if (master) {
                    master.srs = specificCard.srs ? { ...specificCard.srs } : null;
                    if (!specificCard.srs) delete master.srs;
                    console.log(`💾 Single Save: [${master.question.substring(0,10)}]`);
                }
            } 
            // --- 2. BATCH SYNC: Handles ToggleScheduleFlash (The Fix) ---
            else if (window.currentViewMode !== "srs" && typeof reviewCards !== 'undefined' && reviewCards.length > 0) {
                reviewCards.forEach(rCard => {
                    const master = deck.cards.find(c => c.id === rCard.id);
                    if (master) {
                        if (rCard.srs) {
                            master.srs = { ...rCard.srs };
                            // Ensure timestamp logic exists here too if level changed
                            const minutes = SRS_INTERVALS[master.srs.level || 0] || 5;
                            master.srs.nextReview = Date.now() + (minutes * 60 * 1000);
                        } else {
                            delete master.srs;
                        }
                    }
                });
            }
            // --- 3. LEGACY FALLBACK (SRS Review) ---
            else if (typeof currentDueCards !== 'undefined') {
                const now = Date.now();
                currentDueCards.forEach(sCard => {
                    const master = deck.cards.find(c => c.id === sCard.id);
                    if (master) {
                        if (sCard.srs) {
                            master.srs = { ...sCard.srs };
                            const level = sCard.srs.level || 0;
                            const minutes = SRS_INTERVALS[level] || 5; 
                            master.srs.nextReview = now + (minutes * 60 * 1000);
                            
                            console.log(`Saved ${master.question}: Level ${level}, Next Review in ${minutes} mins`);
                        } else {
                            delete master.srs;
                        }
                    }
                });
            }

            // --- 4. PERSIST UI STATE ---
            deck.session = {
                reviewCards: [...(reviewCards || [])],
                isShuffled: !!(typeof isShuffled !== 'undefined' ? isShuffled : false),
                currentChunkStart: typeof currentChunkStart !== 'undefined' ? currentChunkStart : 0,
                chunkIndex: typeof chunkIndex !== 'undefined' ? chunkIndex : 0,
                chunkSize: typeof chunkSize !== 'undefined' ? chunkSize : 20,
                recallQueue: [...(typeof recallQueue !== 'undefined' ? recallQueue : [])],
                matchQueue: [...(typeof matchQueue !== 'undefined' ? matchQueue : [])]
            };

            // Update global reference and write to DB
            currentDeck = deck; 
            const putReq = store.put(deck);
            
            putReq.onerror = (e) => {
                console.error("❌ store.put error:", e);
                reject(e);
            };
        };

        transaction.oncomplete = () => {
            console.log("✅ SaveSession Complete");
            if (typeof updateSRSBadge === "function") updateSRSBadge();
            resolve(); 
        };

        transaction.onerror = (e) => {
            console.error("❌ Transaction error:", e);
            reject(e);
        };
    });
}
function saveDeck() {
    return new Promise((resolve, reject) => {
        const name = document.getElementById('deckInput').value.trim();
        if (!name) {
            alert("Please enter a name");
            resolve(); // Or reject if you prefer
            return;
        }

        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        if (editingId) {
            // RENAME MODE
            const getReq = store.get(editingId);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) {
                    data.name = name;
                    store.put(data);
                }
            };
        } else {
            // NEW DECK MODE
            store.add({ 
                id: Date.now(), 
                name: name, 
                cards: [] 
            });
        }

        transaction.oncomplete = () => {
            closeDeckModal();
            renderDecks(); 
            editingId = null;
            resolve(); // Success!
        };

        transaction.onerror = (err) => {
            console.error("Save Deck failed:", err);
            reject(err);
        };
    });
}

function deleteDeck(id) {
    if (!confirm("Delete this deck?")) return;
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => renderDecks();
}

// --- Card Management & Phrase Logic ---
function openCardModal() {
    // RESET the global index so we don't accidentally overwrite an old card
    editingCardIndex = null; 

    document.getElementById('cardQ').value = '';
    document.getElementById('cardA').value = '';
    document.getElementById('cardPhrase').innerHTML = '';
    document.getElementById('cardNotes').value = '';
    document.getElementById('cardModal').style.display = 'block';
    
    console.log("Adding new card - Index reset to null");
}
/*
function closeCardModal() {
    document.getElementById('cardModal').style.display = 'none';
}
*/
function closeCardModal() {
    editingCardIndex = null; 
    editingCardId = null;

    const modal = document.getElementById('cardModal');
    const editModal = document.getElementById('editCardModal');
    
    if (modal) modal.style.display = 'none';
    if (editModal) editModal.style.display = 'none';
    
    console.log("Modals closed safely.");
}


function phraseClear() { document.getElementById('cardPhrase').innerHTML = ''; }

function phraseRemoveHighlight() {
    const el = document.getElementById('cardPhrase');
    el.innerHTML = el.innerText;
}

function phraseHighlight() {
    const phraseEl = document.getElementById('cardPhrase');
    const questionText = document.getElementById('cardQ').value.trim();
    const selection = window.getSelection();
    const selectedText = selection.toString();

    // 1. Manual Selection (Always takes priority)
    if (selectedText.length > 0 && phraseEl.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.style.fontWeight = 'bold';
        range.surroundContents(span);
        selection.removeAllRanges();
        return;
    }

    // 2. Auto-Highlight (Preserves original casing)
    if (questionText) {
        const currentHTML = phraseEl.innerHTML;
        // 'gi' finds it regardless of case
        const regex = new RegExp(`(${questionText})`, 'gi');
        
        // $1 refers to the specific text found by the regex
        phraseEl.innerHTML = currentHTML.replace(regex, '<span style="font-weight:bold;">$1</span>');
    }
}

function editPhraseHighlight() {
    const phraseEl = document.getElementById('editP');
    const questionText = document.getElementById('editQ').value.trim();
    const selection = window.getSelection();
    const selectedText = selection.toString();

    // 1. Manual Selection
    if (selectedText.length > 0 && phraseEl.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const bTag = document.createElement('b');
        try {
            range.surroundContents(bTag);
        } catch (e) {
            const content = range.extractContents();
            bTag.appendChild(content);
            range.insertNode(bTag);
        }
        selection.removeAllRanges();
        return;
    }

    // 2. Auto-Highlight (Preserves original casing)
    if (questionText) {
        const currentHTML = phraseEl.innerHTML;
        const regex = new RegExp(`(${questionText})`, 'gi'); 
        
        // $1 keeps "Apple" as "Apple" and "apple" as "apple"
        phraseEl.innerHTML = currentHTML.replace(regex, '<b>$1</b>');
    }
}
function editPhraseRemoveHighlight() {
    const el = document.getElementById('editP');
    el.innerHTML = el.innerText;
}
function toggleAlignment() {
    // Check current state, default to center if not set
    const currentAlign = localStorage.getItem('autocard_alignment') || 'center';
    const newAlign = (currentAlign === 'center') ? 'left' : 'center';
    
    localStorage.setItem('autocard_alignment', newAlign);
    applySavedAlignment();
}

// Call this function when opening a card or during app init
function applySavedAlignment() {
    const savedAlign = localStorage.getItem('autocard_alignment') || 'center';
    
    // Updated to include 'revP' and 'revN'
    const targetIds = ['revP', 'revN', 'editP', 'editN', 'srsP', 'srsN', 'cardPhrase', 'cardNotes'];

    targetIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.setProperty('display', 'block', 'important');
            el.style.setProperty('width', '100%', 'important');
            el.style.setProperty('text-align', savedAlign, 'important');
        }
    });

    const srsToggle = document.getElementById('alignToggleBtn');
    const standardToggle = document.getElementById('alignToggleBtnStandard');
    const newIcon = (savedAlign === 'center') ? '≡' : '≣';
    
    if (srsToggle) srsToggle.innerText = newIcon;
    if (standardToggle) standardToggle.innerText = newIcon;
}


function saveCard() {
    if (isUpdating) return;
    isUpdating = true;

    const q = document.getElementById('cardQ').value.trim();
    const a = document.getElementById('cardA').value.trim();
    const p = document.getElementById('cardPhrase').innerHTML;
    const n = document.getElementById('cardNotes').value.trim();
    
    if (!q || !a) {
        isUpdating = false;
        return alert("Fill Q and A");
    }

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);

    getReq.onsuccess = () => {
        const deck = getReq.result;
        if (!deck) { isUpdating = false; return; }
        if (!deck.cards) deck.cards = [];
        
        // --- DUPLICATE GUARD ---
        const exists = deck.cards.some(c => c.question.toLowerCase() === q.toLowerCase());
        if (exists) {
            alert("This question already exists in this deck!");
            isUpdating = false;
            return; 
        }
        // -----------------------
        
        const newCard = { 
            question: q, 
            answer: a, 
            phrase: p, 
            notes: n, 
            id: Date.now() + Math.floor(Math.random() * 1000),
            srs: null 
        };
        
        deck.cards.push(newCard);
        
        store.put(deck).onsuccess = () => {
            currentDeck = deck; 
            // Update the active review list immediately
            reviewCards = [...deck.cards]; 
            console.log("✅ New card created with ID:", newCard.id);
        };
    };
    
    transaction.oncomplete = () => {
        closeCardModal();
        isUpdating = false; 

        var srsModal = document.getElementById('srsModal');
        var standardReview = document.getElementById('view-review');
        var detailView = document.getElementById('view-detail');

        if (srsModal && srsModal.style.display !== 'none') {
            if (typeof renderSRSReview === "function") renderSRSReview();
        } 
        else if (standardReview && standardReview.style.display !== 'none') {
            updateReviewUI();
        } 
        // --- NEW LOGIC HERE ---
        else if (detailView && detailView.style.display !== 'none') {
            // Refresh the "Total: X Cards" and "Next: ..." labels immediately
            if (typeof updateSRSBadge === "function") updateSRSBadge();
            // Refresh the standard list/review UI components
            updateReviewUI();
        }
        else {
            renderDecks();
        }
    };
}
/*
function toggleCardList() {
    const section = document.getElementById('cardListSection');
    section.style.display = (section.style.display === 'none') ? 'block' : 'none';
    if (section.style.display === 'block') renderCardList();
}
*/
function renderCardList() {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);
    getReq.onsuccess = () => {
        const deck = getReq.result;
        const container = document.getElementById('cardRowsContainer');
        const cards = deck.cards || [];
        document.getElementById('cardCount').innerText = cards.length;
        container.innerHTML = '';
        cards.forEach((card, index) => {
            const row = document.createElement('div');
            row.style.display = 'flex'; row.style.gap = '10px'; row.style.padding = '5px 0'; row.style.borderBottom = '1px solid #eee';
            row.innerHTML = `<button onclick="deleteCard(${index})">🗑️</button><span style="flex:1">${card.question}</span><span style="flex:1">${card.answer}</span>`;
            container.appendChild(row);
        });
    };
}

function deleteCard(cardIndex) {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);

    getReq.onsuccess = () => {
        const deck = getReq.result;
        if (!deck || !deck.cards[cardIndex]) return;

        // Remove the card from the array
        deck.cards.splice(cardIndex, 1);

        const updateReq = store.put(deck);
        updateReq.onsuccess = () => {
            console.log("✅ Card deleted successfully.");
            
            // Update the local currentDeck object so the UI matches the DB
            currentDeck = deck; 

            // REPLACEMENT FIX:
            // Use renderDecks() to update the main list background
            if (typeof renderDecks === "function") {
                renderDecks(); 
            }
            
            // Use openDeckDetail() to refresh the current view counts
            if (typeof openDeckDetail === "function" && currentDeckId) {
                openDeckDetail(currentDeckId, deck.name);
            }

            if (typeof renderCardList === "function") {
                renderCardList();
            }
        };
    };
}

// --- Review Screen Logic ---

function startReview() {
    console.log("🚀 Manual Trigger: startReview");
    window.currentViewMode = "standard";
    
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);

    getReq.onsuccess = () => {
        const deck = getReq.result;
        if (!deck || !deck.cards) {
            console.error("❌ startReview: Deck not found");
            return;
        }

        // --- THE SYNC FIX ---
        // We point everything to the SAME object so data can't hide
        currentDeck = deck;
        originalCards = deck.cards; 
        reviewCards = deck.cards; 
        isShuffled = false; 

        if (deck.session) {
            currentChunkStart = deck.session.currentChunkStart || 0;
            chunkIndex = deck.session.chunkIndex || 0;
            chunkSize = deck.session.chunkSize || 20;
        }

        document.getElementById('view-detail').style.display = 'none';
        document.getElementById('view-review').style.display = 'block';
        
        updateReviewUI();
    };
}

function updateReviewUI() {


    // --- SECTION 1: DATA SYNC & INITIALIZATION ---
    if (currentDeck && currentDeck.cards) {
        reviewCards = currentDeck.cards; 
    }

    // Ensure we are always on a grid boundary for the chunking logic
    if (currentChunkStart % chunkSize !== 0) {
        currentChunkStart = Math.floor(currentChunkStart / chunkSize) * chunkSize;
    }

    const scrollContainer = document.getElementById('reviewData');
    if (scrollContainer) scrollContainer.scrollTop = 0;

    if (!reviewCards || reviewCards.length === 0) return;

    
    // --- SECTION 2: MAIN CARD CONTENT AREA ---
    const effectiveChunkSize = Math.min(chunkSize, reviewCards.length - currentChunkStart);
    if (chunkIndex >= effectiveChunkSize) chunkIndex = Math.max(0, effectiveChunkSize - 1);

    const actualCardIndex = currentChunkStart + chunkIndex;
    const card = reviewCards[actualCardIndex] || reviewCards[0];

    const elQ = document.getElementById('revQ');
    const elA = document.getElementById('revA');
    const elP = document.getElementById('revP');
    const elN = document.getElementById('revN');

    if (elQ) elQ.innerText = card.question;
    if (elA) elA.innerText = card.answer;
    if (elN) elN.innerText = card.notes || "";

    if (elP) {
        // 1. Force the GPU to "drop" the previous render layer
        elP.style.visibility = 'hidden'; 
        
        // 2. Wipe the content
        elP.innerHTML = ""; 
        
        // 3. Trigger a layout recalculation (Reflow)
        // This is a dummy variable just to force the browser to work
        const forceReflow = elP.offsetHeight; 
        
        // 4. Inject new content
        elP.innerHTML = card.phrase || "";
        
        // 5. Make it visible again
        elP.style.visibility = 'visible';
    }
    
    if (document.getElementById('cardCounterLabel')) {
        document.getElementById('cardCounterLabel').innerText = `Card ${chunkIndex + 1} / ${effectiveChunkSize}`;
    }
    
    // --- SECTION 3: STANDARD REVIEW LABELS (Total/Remaining) ---
    const totalCardsCount = reviewCards.length;
    const remainingCount = reviewCards.filter(c => !c.srs).length;

    const remSub = document.getElementById('reviewRemainingSub');
    const totSub = document.getElementById('reviewTotalSub');
    if (remSub) remSub.innerText = `Remaining: ${remainingCount} Cards`;
    if (totSub) totSub.innerText = `Total: ${totalCardsCount} Cards`;

    // --- SECTION 4: PROGRESS BAR (Flexbox Segments & Marker) ---
    const pbContainer = document.getElementById('progressBarContainer');
    if (pbContainer) {
        pbContainer.style.cssText = `
            position: relative; width: 100%; height: 18px; margin: 15px 0; 
            border: 1px solid #222; box-sizing: border-box; 
            background-color: #28a745;
            display: flex; flex-direction: row; overflow: visible; z-index: 100;
        `;
        pbContainer.innerHTML = ''; 

        const totalChunks = Math.ceil(reviewCards.length / chunkSize);
        const activeChunkIndex = Math.floor(currentChunkStart / chunkSize);

        for (let i = 0; i < totalChunks; i++) {
            const startIdx = i * chunkSize;
            const endIdx = Math.min(startIdx + chunkSize, reviewCards.length);
            const chunkCards = reviewCards.slice(startIdx, endIdx);
            const isChunkComplete = chunkCards.every(c => c.srs);
            const chunkWidth = (chunkCards.length / reviewCards.length) * 100;

            const chunkBox = document.createElement('div');
            chunkBox.style.cssText = `
                width: ${chunkWidth}%; height: 100%; position: relative; 
                box-sizing: border-box; border-right: 1px solid rgba(0,0,0,0.15);
                background-color: ${isChunkComplete ? '#ffeb3b' : '#28a745'};
            `;

            if (i === activeChunkIndex) {
                chunkBox.style.border = "1px solid #000";
                chunkBox.style.zIndex = "5";
                const marker = document.createElement('div');
                marker.style.cssText = `
                    position: absolute; bottom: 100%; left: 50%; margin-bottom: 4px; 
                    width: 0; height: 0; border-left: 7px solid transparent; 
                    border-right: 7px solid transparent; border-top: 10px solid #000; 
                    transform: translateX(-50%);
                `;
                chunkBox.appendChild(marker);
            }
            pbContainer.appendChild(chunkBox);
        }
    }

    // --- SECTION 5: MODAL VISIBILITY (Recall & Match Blitz) ---
    const qrBtn = document.getElementById('quickRecallBtn');
    const mbBtn = document.getElementById('matchBlitzBtn');
    if (qrBtn) {
        const hasRecall = (typeof recallQueue !== 'undefined' && recallQueue.length > 0);
        qrBtn.style.display = hasRecall ? 'block' : 'none';
        qrBtn.innerText = `Quick Recall (${recallQueue ? recallQueue.length : 0})`;
    }
    if (mbBtn) {
        const hasMatch = (typeof matchQueue !== 'undefined' && matchQueue.length > 0);
        mbBtn.style.display = hasMatch ? 'block' : 'none';
        mbBtn.innerText = `Match Blitz (${matchQueue ? matchQueue.length : 0})`;
    }

    // --- SECTION 6: SCHEDULED & PENDING STATUS LABELS ---
    const srsQtyEl = document.getElementById('inspectedQty'); 
    const penQtyEl = document.getElementById('pendingQty');
    if (srsQtyEl && penQtyEl) {
        const scheduledCount = reviewCards.filter(c => c.srs).length;
        const pendingCount = reviewCards.length - scheduledCount;
        srsQtyEl.innerHTML = `<span style="color: #d4af37; font-weight: bold;">Scheduled: ${scheduledCount}</span>`;
        penQtyEl.innerHTML = `<span style="color: #28a745; font-weight: bold;">Pending: ${pendingCount}</span>`;
    }

    // --- SECTION 7: UI PERSISTENCE (Alignment & Font Size) ---
    if (typeof applySavedAlignment === 'function') applySavedAlignment();
    if (typeof applySavedFontSize === 'function') applySavedFontSize();
}
// NAVIGATION: CHUNK LEVEL
function reviewNextChunk() {
    // Only move forward if there is more deck to cover
    if (currentChunkStart + chunkSize < reviewCards.length) {
        currentChunkStart += chunkSize;
    }
    // If already at end, currentChunkStart stays where it is (Full Bar)
    chunkIndex = 0;
    updateReviewUI();
}

function reviewPrevChunk() {
    // Only move back if we aren't at the start
    if (currentChunkStart - chunkSize >= 0) {
        currentChunkStart -= chunkSize;
    } else {
        currentChunkStart = 0; // Stop at the beginning
    }
    chunkIndex = 0;
    updateReviewUI();
}

function reviewReset() {
    // Hard reset to the very first card
    currentChunkStart = 0;
    chunkIndex = 0;
    updateReviewUI();
    saveSession();
}


function shuffleSRSSession() {
    // 1. Only shuffle if optional icon is clicked AND we have cards
    if (!currentDueCards || currentDueCards.length <= 1) return;

    // 2. Fisher-Yates shuffle currentDueCards
    for (let i = currentDueCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [currentDueCards[i], currentDueCards[j]] = [currentDueCards[j], currentDueCards[i]];
    }

    // 3. Keep secondary queues in sync
    recallQueue = [...currentDueCards];
    matchQueue = [...currentDueCards];
    
    // 4. Reset to the start of this newly shuffled sequence
    srsModalIndex = 0;
    // Note: We don't necessarily reset srsCompletedInSession if you want to keep your overall progress count
    
    // 5. Save the state so a refresh doesn't break the new order
    saveSession(); 

    // 6. Update the UI using your existing render function
    renderSRSModalCard();
    
    console.log("SRS Session order shuffled manually.");
}

function nextCardInChunk() {
    // Calculate how many cards actually exist in this chunk
    const effectiveChunkSize = Math.min(chunkSize, reviewCards.length - currentChunkStart);

    chunkIndex++;

    // Loop back to start if we exceed the actual cards available
    if (chunkIndex >= effectiveChunkSize) {
        chunkIndex = 0;
    }
    
    updateReviewUI();
}

function prevCardInChunk() {
    // Calculate how many cards actually exist in this chunk
    const effectiveChunkSize = Math.min(chunkSize, reviewCards.length - currentChunkStart);

    chunkIndex--;

    // If we go below zero, jump to the last real card in the chunk
    if (chunkIndex < 0) {
        chunkIndex = effectiveChunkSize - 1;
    }
    
    updateReviewUI();
}
function handleReviewTap(e) {
    // Get the horizontal position of the click relative to the container
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (x < rect.width / 2) {
        prevCardInChunk(); // Left side tap
    } else {
        nextCardInChunk(); // Right side tap
    }
}

function adjustChunkSize(val) {
    chunkSize = Math.max(1, chunkSize + val);
    
    // PERMANENT FIX: Snap the current start to the nearest multiple of the new chunk size
    // This prevents starting at odd numbers like 1734.
    currentChunkStart = Math.floor(currentChunkStart / chunkSize) * chunkSize;
    
    chunkIndex = 0; 
    updateReviewUI();
}
function reviewEditCurrent() {
    const actualIndex = currentChunkStart + chunkIndex;
    const card = reviewCards[actualIndex];
    
    if (!card) {
        console.error("No card found at index:", actualIndex);
        return;
    }

    // 1. Identify the ID immediately
    const tempId = (card.id !== undefined && card.id !== null) ? card.id : actualIndex;

    // 2. FORCE assignment with a tiny delay (Fixes Safari race conditions)
    setTimeout(() => {
        editingId = tempId;
        editingCardIndex = actualIndex;

        // Update the Yellow Bar
        const debugId = document.getElementById('debug-id');
        const debugIndex = document.getElementById('debug-index');
        if (debugId) debugId.innerText = tempId;
        if (debugIndex) debugIndex.innerText = actualIndex;

        // Update the Hidden Input Backup
        const secretInput = document.getElementById('editCardSecretId');
        if (secretInput) secretInput.value = tempId;

        console.log("📍 Late-assignment successful. ID:", editingId);
    }, 50);

    // FILL DATA (Visuals)
    document.getElementById('editQ').value = card.question || "";
    document.getElementById('editA').value = card.answer || "";
    
    const pField = document.getElementById('editP');
    if (pField) {
        if (pField.tagName === 'DIV') pField.innerHTML = card.phrase || "";
        else pField.value = card.phrase || "";
    }
    
    document.getElementById('editN').value = card.notes || "";

    const modal = document.getElementById('editCardModal');
    if (modal) {
        modal.style.display = 'block';
        modal.style.zIndex = '4000';
    }
}
async function autoFillDictionary(qId, aId, pId, nId) {
    const wordInput = document.getElementById(qId);
    const word = wordInput.value.trim();
    
    if (!word) return alert("Please enter a word in the Question field first!");

    const btn = event.currentTarget;
    const originalText = btn.innerHTML;
    btn.innerText = "⏳..."; 

    try {
        const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
        if (!response.ok) throw new Error("Word not found");
        
        const data = await response.json();
        const entry = data[0];

        // 1. Get the primary Definition
        const definition = entry.meanings[0].definitions[0].definition;
        
        // 2. Collect ALL unique synonyms from the entire entry
        let allSynonyms = [];
        entry.meanings.forEach(m => {
            if (m.synonyms) allSynonyms.push(...m.synonyms);
        });
        // Remove duplicates
        allSynonyms = [...new Set(allSynonyms)];

        // 3. Set the ANSWER field to the first synonym (if available)
        const firstSynonym = allSynonyms.length > 0 ? allSynonyms[0] : "";
        document.getElementById(aId).value = firstSynonym;

        // 4. Get the first available Example for the PHRASE field
        let example = "";
        for (let m of entry.meanings) {
            for (let d of m.definitions) {
                if (d.example) { example = d.example; break; }
            }
            if (example) break;
        }

        // --- INJECTION ---
        
        // Phrase (Div/ContentEditable)
        const phraseField = document.getElementById(pId);
        if (phraseField.isContentEditable) {
            phraseField.innerHTML = example;
        } else {
            phraseField.value = example;
        }

        // Notes (Textarea) - Clean Definition + Synonym List
        let notesContent = definition;
        
        // Add synonyms to notes if there are more than just the one in the Answer field
        if (allSynonyms.length > 1) {
            notesContent += `\n\nSynonyms: ${allSynonyms.slice(1, 6).join(", ")}`;
        }

        document.getElementById(nId).value = notesContent;

        console.log(`Clean fetch completed for: ${word}`);

    } catch (error) {
        console.error(error);
        alert("Definition not found. Check spelling or try another word.");
    } finally {
        btn.innerHTML = originalText;
    }
}

function deleteCurrentCard() {
    if (!confirm("Are you sure you want to delete this card?")) return;

    const secretInput = document.getElementById('editCardSecretId');
    let rawId = (secretInput && secretInput.value !== "") ? secretInput.value : editingId;
    
    if (!rawId) return alert("Error: Could not identify which card to delete.");
    let targetId = (!isNaN(rawId) && rawId !== "") ? Number(rawId) : rawId;

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);

    getReq.onsuccess = () => {
        const deck = getReq.result;
        if (!deck) return;

        let cardIndex = deck.cards.findIndex(c => c.id === targetId);
        if (cardIndex !== -1) {
            deck.cards.splice(cardIndex, 1);
            
            store.put(deck).onsuccess = () => {
                currentDeck = deck; 
                reviewCards = [...deck.cards];
                
                // --- ADD THIS SRS CLEANUP LOGIC ---
                if (typeof currentDueCards !== 'undefined' && currentDueCards.length > 0) {
                    const srsIdx = currentDueCards.findIndex(c => c.id === targetId);
                    if (srsIdx !== -1) {
                        currentDueCards.splice(srsIdx, 1);
                        // Adjust index so the SRS modal doesn't break
                        if (srsModalIndex >= currentDueCards.length) {
                            srsModalIndex = Math.max(0, currentDueCards.length - 1);
                        }
                    }
                }
                // ----------------------------------

                closeEditModal();
                
                // If the SRS Modal is open, refresh it or close it if empty
                const srsModal = document.getElementById('srsModal');
                if (srsModal && srsModal.style.display !== 'none') {
                    if (currentDueCards.length === 0) {
                        alert("SRS Session complete.");
                        closeSRSModal();
                    } else {
                        renderSRSModalCard();
                    }
                }

                if (reviewCards.length === 0 && typeof exitReview === "function") {
                    exitReview(); 
                } else if (typeof updateReviewUI === "function") {
                    updateReviewUI();
                }

                if (typeof updateSRSBadge === "function") updateSRSBadge();
            };
        }
    };
}

function updateExistingCard() {
    if (window.isUpdating) return;
    window.isUpdating = true;

    var secretInput = document.getElementById('editCardSecretId');
    var targetId = (secretInput && secretInput.value !== "") ? secretInput.value : editingId;

    if (targetId !== null && targetId !== undefined && !isNaN(targetId) && targetId !== "") {
        targetId = Number(targetId);
    }

    var newQ = document.getElementById('editQ').value.trim();
    var newA = document.getElementById('editA').value.trim();
    
    var phraseEl = document.getElementById('editP');
    var updatedPhrase = (phraseEl) ? phraseEl.innerHTML : "";
    var updatedNotes = document.getElementById('editN').value.trim();

    var transaction = db.transaction([STORE_NAME], 'readwrite');
    var store = transaction.objectStore(STORE_NAME);
    var getReq = store.get(currentDeckId);

    getReq.onsuccess = function() {
        var deck = getReq.result;
        if (!deck) { window.isUpdating = false; return; }

        var cardIndex = -1;
        for (var i = 0; i < deck.cards.length; i++) {
            if (deck.cards[i].id === targetId) {
                cardIndex = i;
                break;
            }
        }

        if (cardIndex !== -1) {
            var isDup = false;
            for (var j = 0; j < deck.cards.length; j++) {
                if (j !== cardIndex && deck.cards[j].question.trim().toLowerCase() === newQ.toLowerCase()) {
                    isDup = true;
                    break;
                }
            }

            if (isDup) {
                alert("Duplicate blocked: '" + newQ + "' already exists elsewhere.");
                window.isUpdating = false;
                return;
            }

            // Perform the update in the master deck
            var card = deck.cards[cardIndex];
            card.question = newQ;
            card.answer = newA;
            card.phrase = updatedPhrase; 
            card.notes = updatedNotes;

            // CRITICAL: Update the card in the ACTIVE currentDueCards queue immediately
            // This prevents the "freeze" because the object reference stays valid
            if (window.currentViewMode === "srs" && currentDueCards && currentDueCards[srsModalIndex]) {
                var activeCard = currentDueCards[srsModalIndex];
                if (activeCard.id === targetId) {
                    activeCard.question = newQ;
                    activeCard.answer = newA;
                    activeCard.phrase = updatedPhrase;
                    activeCard.notes = updatedNotes;
                }
            }

            store.put(deck);
        } else {
            alert("Error: Card ID " + targetId + " not found.");
            window.isUpdating = false;
        }
    };

    transaction.oncomplete = function() {
        // Refresh the global currentDeck reference
        const readTx = db.transaction([STORE_NAME], 'readonly');
        readTx.objectStore(STORE_NAME).get(currentDeckId).onsuccess = function(e) {
            currentDeck = e.target.result;
            reviewCards = currentDeck.cards.slice();

            // 1. Hide the edit modal
            const editModal = document.getElementById('editCardModal');
            if (editModal) {
                editModal.style.display = 'none';
                editModal.style.zIndex = "";
            }
            window.isUpdating = false;

            // 2. THE SWITCHBOARD
            if (window.currentViewMode === "srs") {
                console.log("🚀 Refreshing SRS View...");

                // Ensure SRS UI is visible and other views hidden
                const viewList = document.getElementById('view-list');
                const viewDetail = document.getElementById('view-detail');
                const srsModal = document.getElementById('srsModal');
                
                if (viewList) viewList.style.display = 'none';
                if (viewDetail) viewDetail.style.display = 'none';
                if (srsModal) srsModal.style.display = 'flex';

                // We DON'T re-filter currentDueCards here because that triggers the freeze 
                // if the card is suddenly no longer "due". We rely on the live update above.
                
                if (typeof renderSRSModalCard === "function") {
                    renderSRSModalCard(); 
                }
            } 
            else if (window.currentViewMode === "standard") {
                console.log("🚀 Refreshing Standard Review...");
                const stdReview = document.getElementById('view-review');
                if (stdReview) stdReview.style.display = 'block';
                if (typeof updateReviewUI === "function") {
                    updateReviewUI();
                }
            } 
            else {
                if (typeof closeEditModal === "function") closeEditModal(); 
                if (typeof renderDecks === "function") renderDecks();
            }
        };
    };

    transaction.onerror = function() {
        console.error("❌ Transaction failed");
        window.isUpdating = false;
    };
}
function closeEditModal() {
    const modal = document.getElementById('editCardModal');
    if (modal) {
        modal.style.display = 'none';
        modal.style.zIndex = ""; // Clean up the SRS forefront fix
    } else {
        console.warn("Could not find editCardModal to close it.");
    }

    // --- NEW: Search UI Cleanup ---
    // This prevents search results from staying visible when you return to the dashboard
    const searchInput = document.getElementById('deckSearchInput');
    const overlay = document.getElementById('searchResultOverlay');

    if (searchInput) {
        searchInput.value = ''; // Reset the text field
    }

    if (overlay) {
        overlay.style.display = 'none'; // Hide the results
        overlay.innerHTML = '';       // Clear the DOM to save memory
    }
    
    console.log("🧹 UI Cleaned: Modal closed and Search reset.");
}


function updateSRSBadge() {
    const srsBtn = document.getElementById('srsReviewBtn');
    if (!srsBtn || !currentDeck || !currentDeck.cards) return;

    srsBtn.style.position = 'relative';
    const now = Date.now();
    
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfTodayTs = endOfToday.getTime();

    const activeSRS = currentDeck.cards.filter(c => c.srs && !c.srs.mastered);
    
    const dueCount = activeSRS.filter(c => now >= (c.srs.nextReview || 0)).length;
    const upcoming = activeSRS.filter(c => (c.srs.nextReview || 0) > now)
                               .sort((a, b) => a.srs.nextReview - b.srs.nextReview);

    const pendingToday = activeSRS.filter(c => 
        (c.srs.nextReview || 0) > now && (c.srs.nextReview || 0) <= endOfTodayTs
    ).length;

    let nextText = "";
    let labelColor = "#666";

    if (dueCount === 0 && upcoming.length > 0) {
        const nextTime = upcoming[0].srs.nextReview;
        const totalMins = Math.ceil((nextTime - now) / 60000);
        if (totalMins < 60) {
            nextText = `Next: ${totalMins}m`;
            if (totalMins <= 10) labelColor = "#ffcc00"; 
        } else {
            const h = Math.floor(totalMins / 60);
            const m = totalMins % 60;
            nextText = m > 0 ? `Next: ${h}h ${m}m` : `Next: ${h}h`;
        }
    }

    // Calculate the batch size for the (337) part
    const batchSize = upcoming.length > 0 ? activeSRS.filter(c => c.srs.nextReview === upcoming[0].srs.nextReview).length : 0;

    // --- FIX APPLIED HERE: Used activeSRS.length instead of totalInDeck ---
    srsBtn.innerHTML = `
        <span style="font-weight: bold;">SRS Review</span>
        <div style="display: flex; justify-content: center; gap: 5px; font-size: 0.7em; color: #666; margin-top: 2px;">
            <span>Total: ${activeSRS.length} Cards</span>
            <span style="opacity: 0.5;">|</span>
            <span style="color: ${labelColor} !important; font-weight: bold;">
                ${dueCount > 0 ? `${dueCount} Due Now` : `${nextText} (${batchSize})`}
            </span>
        </div>

        <div id="srsBadge" style="
            position: absolute; top: 8px; right: 8px;
            background: #ff4444; color: white; border-radius: 50%; 
            width: 22px; height: 22px; 
            display: ${dueCount > 0 ? 'flex' : 'none'}; 
            align-items: center; justify-content: center; 
            font-size: 11px; font-weight: bold; z-index: 10;
        ">${dueCount}</div>

        <div id="srsPendingBadge" style="
            position: absolute; top: 8px; right: 34px;
            background: #3498db; color: white; border-radius: 50%; 
            width: 22px; height: 22px; 
            display: ${pendingToday > 0 ? 'flex' : 'none'}; 
            align-items: center; justify-content: center; 
            font-size: 11px; font-weight: bold; z-index: 9;
        ">${pendingToday}</div>
    `;

    const externalForceBtn = document.getElementById('forceLoad20Btn');
    if (externalForceBtn) {
        const hasUpcoming = upcoming.length > 0;
        const isDueNow = dueCount > 0;

        externalForceBtn.style.display = hasUpcoming ? 'block' : 'none';

        if (isDueNow) {
            externalForceBtn.disabled = true;
            externalForceBtn.style.background = '#ccc';
            externalForceBtn.style.color = '#888';
            externalForceBtn.style.cursor = 'not-allowed';
            externalForceBtn.innerText = `Finish Due Cards First`;
        } else {
            externalForceBtn.disabled = false;
            externalForceBtn.style.background = '#444';
            externalForceBtn.style.color = 'white';
            externalForceBtn.style.cursor = 'pointer';
            externalForceBtn.innerText = `Force Load Next 20`;
        }
    }
}
function getDueCount(deck) {
    if (!deck || !deck.cards) return 0;
    const now = Date.now();
    return deck.cards.filter(c => c.srs && !c.srs.mastered && now >= (c.srs.nextReview || 0)).length;
}
// Specifically removes ALL yellow scheduled items
function resetSchedule() {
    // Check if there is anything to reset (either scheduled or mastered)
    const hasAnySRSData = reviewCards.some(c => c.srs);
    
    if (flashedChunks.length === 0 && !hasAnySRSData) return;
    
    if (confirm("Reset everything? This will clear all scheduled items AND all mastered progress.")) {
        // 1. Clear the visual segments (removes yellow from progress bar)
        flashedChunks = [];

        // 2. Completely remove the SRS object from every card
        reviewCards.forEach(card => {
            if (card.srs) {
                delete card.srs;
            }
        });

        // 3. Persist the blank slate to IndexedDB
        saveSession();

        // 4. Update the UI components
        updateReviewUI(); // Re-renders the progress bar
        updateSRSBadge(); // Resets the badge, timer, and mastery count
        
        console.log("All SRS and Mastery data cleared.");
    }
}

async function toggleScheduleFlash() {
    const chunkStart = currentChunkStart;
    const chunkEnd = Math.min(chunkStart + chunkSize, currentDeck.cards.length); 
    const flashIndex = flashedChunks.indexOf(chunkStart);

    if (flashIndex !== -1) {
        flashedChunks.splice(flashIndex, 1);
        for (let i = chunkStart; i < chunkEnd; i++) {
            if (currentDeck.cards[i]) delete currentDeck.cards[i].srs;
        }
    } else {
        flashedChunks.push(chunkStart);
        const targetNextReview = Date.now() + (SRS_INTERVALS[0] * 60000);
        for (let i = chunkStart; i < chunkEnd; i++) {
            if (currentDeck.cards[i]) {
                currentDeck.cards[i].srs = { level: 0, mastered: false, nextReview: targetNextReview };
            }
        }
    }

    await saveSession(); // This is the most important line
    reviewCards = currentDeck.cards.slice();
    updateReviewUI(); 
    if (typeof updateSRSBadge === "function") await updateSRSBadge();
}

/*
async function startSRSReview(forceLoadPostponed = false) {
    window.currentViewMode = "srs";
    if (!currentDeck || !currentDeck.cards) return;
    
    const now = Date.now();
    const source = currentDeck.cards; 
    
    let allDue = [];
    let soonestDue = Infinity;
    let nextBatchCount = 0;

    if (forceLoadPostponed) {
        allDue = source.filter(c => c.srs && !c.srs.mastered && (c.srs.nextReview > now))
                       .sort((a, b) => (a.srs.nextReview || 0) - (b.srs.nextReview || 0)); 
    } else {
        const currentlyDue = source.filter(c => {
            if (!c.srs || c.srs.mastered) return false;
            return now >= (c.srs.nextReview || 0);
        });

        // --- SORTING LOGIC ---
        // --- PRIORITY: Oldest Backlog First ---
        allDue = currentlyDue.sort((a, b) => (a.srs.nextReview || 0) - (b.srs.nextReview || 0));
        
        const upcoming = source.filter(c => c.srs && !c.srs.mastered && (c.srs.nextReview > now));
        if (upcoming.length > 0) {
            const sortedUpcoming = upcoming.sort((a, b) => a.srs.nextReview - b.srs.nextReview);
            soonestDue = sortedUpcoming[0].srs.nextReview;
            nextBatchCount = source.filter(c => 
                c.srs && !c.srs.mastered && c.srs.nextReview === soonestDue
            ).length;
        }
    }

    if (typeof updateSRSBadge === "function") updateSRSBadge();

    if (allDue.length === 0) {
        if (!forceLoadPostponed) {
            if (confirm("Queue is clear! Load next 20 cards anyway?")) {
                await startSRSReview(true);
                return;
            }
        } else {
            alert("Queue is clear!");
        }
        return;
    }

    currentDueCards = allDue.length > 20 ? allDue.slice(0, 20) : allDue;

    if (allDue.length > 20 && !forceLoadPostponed) {
        await postponeExcessCards(allDue.slice(20));
    }

    srsTotalSessionCount = currentDueCards.length;
    srsCompletedInSession = 0;
    srsModalIndex = 0;
    recallQueue = [...currentDueCards]; 
    matchQueue = [...currentDueCards];

    await saveSession(); 
    
    const modal = document.getElementById('srsModal');
    if (modal) {
        modal.style.display = 'flex';
        renderSRSModalCard();
    }
}
*/
async function startSRSReview(forceLoadPostponed = false) {
    window.currentViewMode = "srs";
    if (!currentDeck || !currentDeck.cards) return;
    
    const now = Date.now();
    const source = currentDeck.cards; 
    
    let allDue = [];

    if (forceLoadPostponed) {
        // Force Load: Grabs everything due in the future, sorted by soonest first
        allDue = source.filter(c => c.srs && !c.srs.mastered && (c.srs.nextReview > now))
                       .sort((a, b) => (a.srs.nextReview || 0) - (b.srs.nextReview || 0)); 
    } else {
        // Normal Load: Only grabs currently due cards
        const currentlyDue = source.filter(c => {
            if (!c.srs || c.srs.mastered) return false;
            return now >= (c.srs.nextReview || 0);
        });

        // Priority: Oldest overdue cards first
        allDue = currentlyDue.sort((a, b) => (a.srs.nextReview || 0) - (b.srs.nextReview || 0));
    }

    if (typeof updateSRSBadge === "function") updateSRSBadge();

    if (allDue.length === 0) {
        if (!forceLoadPostponed) {
            if (confirm("Queue is clear! Load next 20 cards anyway?")) {
                await startSRSReview(true);
                return;
            }
        } else {
            alert("No cards available to review!");
        }
        return;
    }

    // Always take the first 20 (or fewer if less than 20 exist)
    currentDueCards = allDue.length > 20 ? allDue.slice(0, 20) : allDue;

    // --- DELAY OPTION REMOVED: No call to postponeExcessCards ---

    srsTotalSessionCount = currentDueCards.length;
    srsCompletedInSession = 0;
    srsModalIndex = 0;
    recallQueue = [...currentDueCards]; 
    matchQueue = [...currentDueCards];

    await saveSession(); 
    
    const modal = document.getElementById('srsModal');
    if (modal) {
        modal.style.display = 'flex';
        renderSRSModalCard();
    }
}
function adjustSRSInterval(delta) {
    const card = currentDueCards[srsModalIndex];
    if (!card || !card.srs) return;
    
    // Update data level
    let currentLevel = card.srs.level || 0;
    let newLevel = Math.min(SRS_INTERVALS.length - 1, Math.max(0, currentLevel + delta));
    card.srs.level = newLevel;
    
    // Sync all UI labels
    syncSRSIntervalLabels(newLevel);
    
    if (navigator.vibrate) navigator.vibrate(10);
}
// Formats minutes into human readable text (10m, 3h, 2d)
function formatMins(mins) {
    if (mins < 60) return mins + "m";
    if (mins < 1440) return Math.round(mins / 60) + "h";
    return Math.round(mins / 1440) + "d";
}

function updateIntervalDisplay(mins) {
    const display = document.getElementById('modalIntervalText');
    if (display) {
        display.innerText = formatMins(mins);
        // Quick visual pop
        display.style.transform = "scale(1.2)";
        setTimeout(() => display.style.transform = "scale(1)", 100);
    }
}
/*
async function postponeExcessCards(cards) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(currentDeckId);

        getReq.onsuccess = () => {
            const deck = getReq.result;
            if (!deck) return resolve();

            const newTime = Date.now() + 3600000; // 1 Hour from now
            const targetIds = new Set(cards.map(c => c.id));

            deck.cards.forEach(card => {
                if (targetIds.has(card.id)) {
                    if (!card.srs) card.srs = { level: 0, mastered: false };
                    card.srs.nextReview = newTime;
                }
            });

            // Update local memory so UI stays in sync immediately
            currentDeck = deck; 
            reviewCards = deck.cards.slice();
            
            store.put(deck);
        };

        transaction.oncomplete = () => {
            console.log(`%c ⏳ Postponed ${cards.length} older cards by 1 hour.`, "color: #ffa500");
            if (typeof updateSRSBadge === "function") updateSRSBadge();
            resolve();
        };

        transaction.onerror = (e) => reject(e);
    });
}
*/
async function postponeExcessCards(cards) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get(currentDeckId);

        getReq.onsuccess = () => {
            const deck = getReq.result;
            if (!deck) return resolve();

            const now = Date.now();
            
            // THE TODAY CAP: Calculate 11:59:59 PM for tonight
            const endOfToday = new Date();
            endOfToday.setHours(23, 59, 59, 999);
            const endOfTodayTs = endOfToday.getTime();

            // Calculate the standard 1-hour delay
            let newTime = now + 3600000; 
            
            // If 1 hour from now crosses midnight, cap it at the very end of today
            if (newTime > endOfTodayTs) {
                newTime = endOfTodayTs;
            }

            const targetIds = new Set(cards.map(c => c.id));

            deck.cards.forEach(card => {
                if (targetIds.has(card.id)) {
                    if (!card.srs) card.srs = { level: 0, mastered: false };
                    card.srs.nextReview = newTime;
                }
            });

            currentDeck = deck; 
            reviewCards = deck.cards.slice();
            store.put(deck);
        };

        transaction.oncomplete = () => {
            console.log(`%c ⏳ Postponed ${cards.length} cards within today's window.`, "color: #ffa500");
            if (typeof updateSRSBadge === "function") updateSRSBadge();
            resolve();
        };

        transaction.onerror = (e) => reject(e);
    });
}
function renderSRSModalCard() {
    if (!currentDueCards || currentDueCards.length === 0) {
        closeSRSModal();
        return;
    }
    if (srsModalIndex >= currentDueCards.length) srsModalIndex = 0;
    const card = currentDueCards[srsModalIndex]; 
    if (!card) return;

    // --- 1. CLEANUP PREVIOUS STATS (If existing) ---
    const oldBar = document.getElementById('srsPreviewStats');
    if (oldBar) oldBar.remove();

    // --- 2. MAIN TEXT CONTENT ---
    document.getElementById('srsQ').innerText = card.question || "";
    document.getElementById('srsA').innerText = card.answer || "";
    
    const phraseEl = document.getElementById('srsP');
    const notesEl = document.getElementById('srsN');
    if (phraseEl) {
        phraseEl.innerHTML = card.phrase || "";
        phraseEl.style.display = card.phrase ? "block" : "none";
    }
    if (notesEl) {
        notesEl.innerText = card.notes || "";
        notesEl.style.display = card.notes ? "block" : "none";
    }

    // --- 3. COUNTER UI ---
    const counterEl = document.getElementById('srsCounter');
    if (counterEl) {
        const remainingCount = currentDueCards.length;
        counterEl.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; border-radius: 8px;">
                <div style="display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; background: rgba(255,255,255,0.9); border-radius: 6px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                        <span style="font-size: 8px; color: #bbb; text-transform: uppercase; font-weight: bold;">Total</span>
                        <span style="color: #bbb; font-weight: bold; font-size: 10px;">${srsCompletedInSession + 1}/${srsTotalSessionCount}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                        <span style="font-size: 8px; color: #888; text-transform: uppercase; font-weight: bold;">Loop</span>
                        <span style="color: #888; font-weight: bold; font-size: 10px;">${srsModalIndex + 1}/${remainingCount}</span>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 26px; padding: 2px 0px; background: #f4f4f4; border: 1.5px solid #ddd; border-radius: 8px;">
                    <span style="font-size: 18px; font-weight: 900; color: #444; line-height: 1;">${remainingCount}</span>
                    <span style="font-size: 7px; color: #888; text-transform: uppercase; font-weight: bold; margin-top: 1px;">Left</span>
                </div>
            </div>
        `;
    }

    // Initial Sync (This now triggers the count updates in the buttons)
    if (!card.srs) card.srs = { level: 0, mastered: false };
    syncSRSIntervalLabels(card.srs.level);
    
    applySavedAlignment();
    applySavedFontSize();
}
function syncSRSIntervalLabels(level) {
    const center = document.getElementById('modalIntervalText');
    const prev = document.getElementById('modalPrevLabel');
    const next = document.getElementById('modalNextLabel');

    const prevLevel = Math.max(0, level - 1);
    const nextLevel = Math.min(SRS_INTERVALS.length - 1, level + 1);

    // Helper to count cards at a specific level
    const getCount = (lvl) => {
        if (!currentDeck || !currentDeck.cards) return 0;
        return currentDeck.cards.filter(c => c.srs && !c.srs.mastered && c.srs.level === lvl).length;
    };

    if (center) {
        center.innerHTML = `${getIntervalLabel(level)} <span style="font-size: 0.8em; color: #007bff; opacity: 0.7;">(${getCount(level)})</span>`;
    }
    
    if (prev) {
        prev.innerHTML = `${getIntervalLabel(prevLevel)} (<b>${getCount(prevLevel)}</b>)`;
    }
    
    if (next) {
        const nextLabel = level >= SRS_INTERVALS.length - 1 ? "Mastery" : getIntervalLabel(nextLevel);
        const countDisplay = level >= SRS_INTERVALS.length - 1 ? "" : ` (<b>${getCount(nextLevel)}</b>)`;
        next.innerHTML = `${nextLabel}${countDisplay}`;
    }
}

function navigateSRSQueue(delta) {
    srsModalIndex += delta;
    if (srsModalIndex >= currentDueCards.length) srsModalIndex = 0;
    if (srsModalIndex < 0) srsModalIndex = currentDueCards.length - 1;
    renderSRSModalCard();
}

async function handleSRSClick(type) {
    const card = currentDueCards[srsModalIndex];
    if (!card || !card.srs) return;

    const now = Date.now();

    // --- ADDED FOR TODAY'S COUNT ---
    card.srs.lastReview = now; 

    const labelMap = {
        'prev': 'modalPrevLabel',
        'next': 'modalNextLabel',
        'stay': 'modalIntervalText'
    };

    const targetId = labelMap[type];
    const labelEl = document.getElementById(targetId);
    if (!labelEl) return;

    const labelText = labelEl.innerText.trim();
    const minutes = parseLabelToMinutes(labelText);

    if (minutes > 0) {
        const targetLevel = SRS_INTERVALS.indexOf(minutes);
        if (targetLevel !== -1) {
            card.srs.level = targetLevel;
        }
        card.srs.nextReview = now + (minutes * 60000);
    }

    if (card.srs.level >= SRS_INTERVALS.length - 1) card.srs.mastered = true;

    // --- FIX FOR THE "40 CARDS" BUG ---
    // When adding to game queues, ensure we aren't adding duplicates
    recallQueue = [card, ...recallQueue.filter(c => c.question !== card.question)];
    matchQueue = [card, ...matchQueue.filter(c => c.question !== card.question)];

    await saveSession(card);
    srsCompletedInSession++;
    currentDueCards.splice(srsModalIndex, 1);

    if (currentDueCards.length === 0) {
        await saveSession(); 
        closeSRSModal();
        return;
    }
    if (srsModalIndex >= currentDueCards.length) srsModalIndex = 0;
    renderSRSModalCard();
}

function parseLabelToMinutes(label) {
    if (!label) return 0;
    const cleanLabel = label.toLowerCase().trim();
    if (cleanLabel.includes('mastery')) return 0;
    
    // Handles multi-part labels like "1d 5h" or "10h 30m"
    const parts = cleanLabel.split(/\s+/);
    let totalMinutes = 0;

    parts.forEach(part => {
        const val = parseInt(part);
        if (isNaN(val)) return;
        
        if (part.includes('d')) {
            totalMinutes += val * 1440;
        } else if (part.includes('h')) {
            totalMinutes += val * 60;
        } else if (part.includes('m')) {
            totalMinutes += val;
        } else {
            // Fallback for raw numbers
            totalMinutes += val;
        }
    });

    return totalMinutes;
}
function loopSRS(direction = 1) {
    if (!currentDueCards || currentDueCards.length === 0) return;

    const len = currentDueCards.length;
    
    // Direction logic: direction will be 1 or -1
    // (srsModalIndex + direction + len) % len handles the wrap-around perfectly
    srsModalIndex = (srsModalIndex + direction + len) % len;
    
    renderSRSModalCard();
    
    // Minimal vibration for feedback on iPhone
    if (window.navigator && window.navigator.vibrate) {
        window.navigator.vibrate(2); 
    }
}


function closeSRSModal() {
    const modal = document.getElementById('srsModal');
    if (modal) {
        modal.style.display = 'none';
    }

    // Reset the mode so future edits don't try to go back to SRS
    window.currentViewMode = "none";

    // --- THE FIX: BRING BACK THE BACKGROUND ---
    // Show the detail view (the screen with the "Review" and "SRS Review" buttons)
    const detailView = document.getElementById('view-detail');
    if (detailView) {
        detailView.style.display = 'block';
    }

    // Optional: Refresh the counts/dashboard
    if (typeof renderDecks === "function") {
        renderDecks(); 
    }
    
    console.log("SRS Session closed. Dashboard updated.");
}

function formatSRSInterval(minutes) {
    if (minutes <= 0) return `1m`; 
    if (minutes < 60) return `${minutes}m`;
    
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    
    if (h < 24) {
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function getIntervalLabel(level) {
    const safeLevel = Math.min(Math.max(0, level), SRS_INTERVALS.length - 1);
    const mins = SRS_INTERVALS[safeLevel];
    return formatSRSInterval(mins);
}
function getQueueCountForInterval(intervalMins) {
    if (!currentDeck || !currentDeck.cards) return 0;
    const now = Date.now();
    const targetTime = now + (intervalMins * 60000);
    
    // We define a "match" as any card due within 1 minute of that target 
    // to account for the slight delay between rendering and clicking.
    // Or more simply: count cards already scheduled for that exact time.
    return currentDeck.cards.filter(c => {
        return c.srs && !c.srs.mastered && c.srs.nextReview === targetTime;
    }).length;
}


//QUICK RECALL
function startQuickRecall() {
    // 1. SYNC & MERGE: Combine memory with saved session
    let sessionCards = [];
    if (currentDeck && currentDeck.session && currentDeck.session.recallQueue) {
        sessionCards = currentDeck.session.recallQueue;
    }

    // Combine what's in memory (from Today's Review) with what's in the DB
    const combined = [...recallQueue, ...sessionCards];

    // 2. DEDUPLICATE: Use a Map with 'question' as the key to ensure uniqueness
    // This prevents the "40 cards" bug where cards appear twice
    const uniqueMap = new Map();
    combined.forEach(card => {
        if (card && card.question) {
            uniqueMap.set(card.question, card);
        }
    });

    recallQueue = Array.from(uniqueMap.values());

    console.log("Quick Recall Start. Unique Queue length:", recallQueue.length);

    // 3. CHECK
    if (recallQueue.length === 0) {
        alert("Quick Recall queue is empty. Complete a review first!");
        return;
    }

    // 4. START: Proceed with the game logic
    recallIndex = 0;
    shuffleArray(recallQueue);
    
    const modal = document.getElementById('recallModal');
    if (modal) {
        modal.style.display = 'flex';
        renderRecallCard();
    } else {
        console.error("Recall Modal element not found.");
    }
}

// Helper function to scramble the cards
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function renderRecallCard() {
    if (recallIndex >= recallQueue.length) {
        closeQuickRecall();
        return;
    }

    const card = recallQueue[recallIndex];
    const qEl = document.getElementById('recallQuestion');
    const pEl = document.getElementById('recallPhrase'); 
    const btnA = document.getElementById('recallOptionA');
    const btnB = document.getElementById('recallOptionB');
    const counter = document.getElementById('recallCounter');
    const isAnswerMode = document.getElementById('recallModeToggle').checked;

    // Reset Buttons
    [btnA, btnB].forEach(btn => {
        if (btn) {
            btn.style.backgroundColor = "#f4f4f4";
            btn.style.color = "#333";
            btn.disabled = false;
        }
    });

    if (counter) counter.innerText = `${recallIndex + 1} / ${recallQueue.length}`;
    if (pEl) pEl.innerHTML = card.phrase || ""; 

    // --- MODE LOGIC ---
    if (isAnswerMode) {
        // Mode: SHOW ANSWER -> PICK QUESTION
        qEl.innerText = card.answer;
        
        let other = reviewCards.filter(c => c.question !== card.question);
        let distractor = other.length > 0 ? other[Math.floor(Math.random() * other.length)].question : "???";

        recallCorrectIdx = Math.random() < 0.5 ? 0 : 1;
        btnA.innerText = (recallCorrectIdx === 0) ? card.question : distractor;
        btnB.innerText = (recallCorrectIdx === 1) ? card.question : distractor;

    } else {
        // Mode: SHOW QUESTION -> PICK ANSWER
        qEl.innerText = card.question;

        let other = reviewCards.filter(c => c.answer !== card.answer);
        let distractor = other.length > 0 ? other[Math.floor(Math.random() * other.length)].answer : "???";

        recallCorrectIdx = Math.random() < 0.5 ? 0 : 1;
        btnA.innerText = (recallCorrectIdx === 0) ? card.answer : distractor;
        btnB.innerText = (recallCorrectIdx === 1) ? card.answer : distractor;
    }
}

function handleRecallSelection(selectedIdx) {
    const btnA = document.getElementById('recallOptionA');
    const btnB = document.getElementById('recallOptionB');
    const selectedBtn = selectedIdx === 0 ? btnA : btnB;

    if (selectedIdx === recallCorrectIdx) {
        selectedBtn.style.backgroundColor = "#d4edda"; // Green Background
        selectedBtn.style.color = "#155724";
        
        btnA.disabled = true;
        btnB.disabled = true;
        
        if (navigator.vibrate) navigator.vibrate(10);
        
        setTimeout(() => {
            recallIndex++;
            renderRecallCard(); 
        }, 250); 
    } else {
        selectedBtn.style.backgroundColor = "#f8d7da"; // Red Background
        selectedBtn.style.color = "#721c24";
        
        if (navigator.vibrate) navigator.vibrate([40, 40]);

        setTimeout(() => {
            selectedBtn.style.backgroundColor = "#f4f4f4";
            selectedBtn.style.color = "#333";
        }, 400);
    }
}

function closeQuickRecall() {
    const modal = document.getElementById('recallModal');
    if (modal) modal.style.display = 'none';

    if (recallQueue.length > 0 && recallIndex >= recallQueue.length) {
        console.log("Quick Recall finished.");
        // Optional: Trigger Match Blitz here
    } else {
        console.log("Quick Recall paused. Cards remaining: " + (recallQueue.length - recallIndex));
    }

    updateReviewUI();
}
function startRandomDeckChallenge() {
    // 1. CHECK: Ensure the current deck has cards loaded
    if (!reviewCards || reviewCards.length === 0) {
        alert("This deck has no cards to challenge!");
        return;
    }

    // 2. CLONE & SHUFFLE: Copy the current deck's cards
    let pool = [...reviewCards];
    shuffleArray(pool);

    // 3. SELECT: Take up to 20 cards (handles decks smaller than 20)
    recallQueue = pool.slice(0, 20);

    console.log(`Random Challenge Started for current deck. Selection: ${recallQueue.length} cards.`);

    // 4. RESET & START: Launch the same modal used by Quick Recall
    recallIndex = 0;
    const modal = document.getElementById('recallModal');
    
    if (modal) {
        modal.style.display = 'flex';
        renderRecallCard();
    } else {
        console.error("Recall Modal element not found.");
    }
}

//MATCH BLITZ
function startMatchBlitz() {
    // 1. Sync the global matchQueue from the current deck's saved session
    // We check currentDeck.session first to see if cards were saved there
    if (currentDeck && currentDeck.session && currentDeck.session.matchQueue) {
        matchQueue = [...currentDeck.session.matchQueue];
    }

    // 2. Safety Check: If the queue is empty, don't open the modal
    if (!matchQueue || matchQueue.length === 0) {
        alert("Match Blitz queue is empty for this deck. Complete an SRS review first!");
        return;
    }

    console.log(`⚡ Match Blitz Start. Cards loaded for ${currentDeck.name || 'Deck'}: ${matchQueue.length}`);

    // 3. Open the modal and render
    const modal = document.getElementById('matchModal');
    if (modal) {
        modal.style.display = 'flex';
        renderMatchScreen();
    } else {
        console.error("Match Modal element not found.");
    }
}
function renderMatchScreen() {
    const grid = document.getElementById('matchGrid');
    grid.innerHTML = ''; // Clear previous set
    
    // 1. Progress calculation
    const progress = document.getElementById('matchProgress');
    if (progress) progress.innerText = `${matchQueue.length} remaining`;

    // 2. Pull next 4 cards
    currentMatchSet = matchQueue.splice(0, 4);
    
    if (currentMatchSet.length === 0) {
        closeMatchBlitz();
        return;
    }

    // 3. Prepare shuffled answers
    let answers = currentMatchSet.map((c, index) => ({ text: c.answer, id: index }));
    shuffleArray(answers);

    // 4. Render as siblings in the grid (Left-Right-Left-Right)
    currentMatchSet.forEach((card, i) => {
        // Question (Left)
        const qDiv = document.createElement('div');
        qDiv.id = `matchQ-${i}`;
        qDiv.innerText = card.question;
        qDiv.style.cssText = `background:#2a2a2a; padding:15px; border-radius:8px; display:flex; align-items:center; justify-content:center; text-align:center; border:2px solid transparent; min-height:60px; font-weight:500;`;
        if (card.question.length > 20) qDiv.style.fontSize = "0.9em";
        
        // Answer (Right)
        const matchedAns = answers[i]; // This is just the shuffled slot
        const aBtn = document.createElement('button');
        aBtn.innerText = matchedAns.text;
        aBtn.dataset.answer = matchedAns.text;
        aBtn.style.cssText = `background:#333; color:white; border:1px solid #444; border-radius:8px; cursor:pointer; font-weight:bold; min-height:60px;`;
        if (matchedAns.text.length > 20) aBtn.style.fontSize = "0.85em";
        
        aBtn.onclick = (e) => handleMatchAttempt(matchedAns.text, e.target);

        grid.appendChild(qDiv);
        grid.appendChild(aBtn);
    });

    activeMatchIdx = 0;
    highlightActiveQuestion();
}
function handleMatchAttempt(selectedAnswer, clickedBtn) {
    const currentQ = currentMatchSet[activeMatchIdx];
    const qDiv = document.getElementById(`matchQ-${activeMatchIdx}`);

    if (selectedAnswer === currentQ.answer) {
        // SUCCESS: Text turns Green
        clickedBtn.style.color = "#2ecc71";
        clickedBtn.style.borderColor = "#2ecc71";
        clickedBtn.disabled = true;

        setTimeout(() => {
            // Hide the button and move to next
            clickedBtn.style.visibility = "hidden";
            activeMatchIdx++;

            if (activeMatchIdx >= currentMatchSet.length) {
                // Set finished, load next 4
                renderMatchScreen();
            } else {
                // Highlight the next question in the current set
                highlightActiveQuestion();
            }
        }, 200); 
    } else {
        // FAIL: Text turns Red
        clickedBtn.style.color = "#e74c3c";
        clickedBtn.style.borderColor = "#e74c3c";
        
        setTimeout(() => {
            // Reset to default
            clickedBtn.style.color = "white";
            clickedBtn.style.borderColor = "#444";
        }, 400);
    }
}

function highlightActiveQuestion() {
    currentMatchSet.forEach((_, i) => {
        const qDiv = document.getElementById(`matchQ-${i}`);
        if (!qDiv) return;

        if (i === activeMatchIdx) {
            // CURRENT ACTIVE QUESTION
            qDiv.style.borderColor = "#3498db"; // Blue highlight
            qDiv.style.opacity = "1";
            qDiv.style.boxShadow = "0 0 10px rgba(52, 152, 219, 0.3)";
        } else if (i < activeMatchIdx) {
            // ALREADY MATCHED
            qDiv.style.borderColor = "transparent";
            qDiv.style.opacity = "0.2"; // Heavily dimmed
            qDiv.style.boxShadow = "none";
        } else {
            // UPCOMING QUESTIONS
            qDiv.style.borderColor = "transparent";
            qDiv.style.opacity = "0.5"; // Slightly faded
            qDiv.style.boxShadow = "none";
        }
    });
}

function closeMatchBlitz() {
    const modal = document.getElementById('matchModal');
    if (modal) modal.style.display = 'none';
    
    // 1. If closed mid-set, put the 4 active cards back
    if (currentMatchSet && activeMatchIdx < currentMatchSet.length) {
        const remainingInSet = currentMatchSet.slice(activeMatchIdx);
        matchQueue = [...remainingInSet, ...matchQueue];
    }
    
    // 2. THE STICKY FIX: If the game is totally finished (queue is 0),
    // refill it from the saved session so the button stays visible.
    if (matchQueue.length === 0 && currentDeck && currentDeck.session && currentDeck.session.matchQueue) {
        matchQueue = [...currentDeck.session.matchQueue]; 
    }

    // 3. Save the state so it doesn't "ghost" into other decks
    if (currentDeck && currentDeck.session) {
        currentDeck.session.matchQueue = [...matchQueue];
    }
    
    currentMatchSet = []; 
    saveSession(); // Lock it in
    updateReviewUI(); // Refresh the buttons
}

function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            let content = e.target.result;
            
            // Note: We don't indiscriminately convert "" to ' here anymore because 
            // the column parser splits things cleanly via regex.

            const lines = content.split(/\r?\n/).filter(line => line.trim() !== "");
            lines.shift(); // Remove headers

            let newCards = lines.map((line, index) => {
                // Splits lines safely by matching content inside quotes
                const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                const clean = (values || []).map(v => v.replace(/^"|"$/g, "").trim());

                // Build the baseline card object
                const card = {
                    id: Date.now() + "-" + index + "-" + Math.floor(Math.random() * 1000),
                    question: clean[0] || "",
                    answer: clean[1] || "",
                    phrase: clean[2] || "",
                    notes: clean[3] || ""
                };

                // --- READ SRS DATA: Check if column 5 contains valid saved scheduling ---
                const rawSrs = clean[4] || "";
                if (rawSrs && rawSrs !== "") {
                    try {
                        // Put the double quotes back so JSON.parse can read it safely
                        const standardJsonSyntax = rawSrs.replace(/'/g, '"');
                        card.srs = JSON.parse(standardJsonSyntax);
                    } catch (srsErr) {
                        console.warn("Could not parse SRS data for card row " + index, srsErr);
                    }
                }

                return card;
            });

            // Strip out ghost lines
            newCards = newCards.filter(card => card.question.trim() !== "" || card.answer.trim() !== "");

            const deckName = file.name.replace(".csv", "");
            const transaction = db.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);

            store.put({ name: deckName, cards: newCards });

            transaction.oncomplete = () => {
                alert(`Import Successful! Loaded ${newCards.length} cards with tracking preservation.`);
                renderDecks();
            };
        } catch (err) {
            console.error("Import failed:", err);
            alert("Check console for error.");
        }
    };
    reader.readAsText(file, "UTF-8");
}

function exportCurrentDeck() {
    if (!currentDeckId) {
        alert("Please select a deck first.");
        return;
    }

    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(currentDeckId);

    request.onsuccess = () => {
        const deck = request.result;
        if (!deck || !deck.cards) {
            alert("No cards found in this deck to export.");
            return;
        }

        // --- UPDATED HEADER: Added SRS_Data column ---
        const header = "Question,Answer,Phrase,Notes,SRS_Data\n";
        
        const csvRows = deck.cards.map(card => {
            const cleanQ = (card.question || "").replace(/"/g, "'").replace(/[\r\n]+/g, "<br>");
            const cleanA = (card.answer || "").replace(/"/g, "'").replace(/[\r\n]+/g, "<br>");
            const cleanP = (card.phrase || "").replace(/"/g, "'").replace(/[\r\n]+/g, "<br>");
            const cleanN = (card.notes || "").replace(/"/g, "'").replace(/[\r\n]+/g, "<br>");

            // --- SAVE SRS DATA: Convert the srs tracking object into a string ---
            // We swap double quotes to single quotes here so it safely wraps inside the CSV column
            const srsString = card.srs ? JSON.stringify(card.srs).replace(/"/g, "'") : "";

            return `"${cleanQ}","${cleanA}","${cleanP}","${cleanN}","${srsString}"`;
        }).join("\n");

        const csvContent = header + csvRows;

        // UI Overlay Code
        const container = document.createElement('div');
        container.id = "export-container";
        container.style.cssText = "position:fixed; top:5%; left:5%; width:90%; height:85%; z-index:10000; background:#fff; border:3px solid #333; border-radius:12px; display:flex; flex-direction:column; padding:10px; box-shadow:0 10px 30px rgba(0,0,0,0.5);";

        const copyArea = document.createElement('textarea');
        copyArea.value = csvContent;
        copyArea.style.cssText = "flex:1; width:100%; font-family:monospace; font-size:12px; border:1px solid #ddd; padding:8px; margin-bottom:10px;";
        
        const copyBtn = document.createElement('button');
        copyBtn.innerText = "📋 COPY ALL TEXT";
        copyBtn.style.cssText = "width:100%; height:50px; background:#222; color:#fff; font-weight:bold; border:none; border-radius:8px; margin-bottom:8px; font-size:16px; cursor:pointer;";
        
        copyBtn.onclick = () => {
            copyArea.select();
            copyArea.setSelectionRange(0, 99999);
            try {
                navigator.clipboard.writeText(copyArea.value);
                copyBtn.innerText = "✅ COPIED!";
                copyBtn.style.background = "#555";
                setTimeout(() => {
                    copyBtn.innerText = "📋 COPY ALL TEXT";
                    copyBtn.style.background = "#222";
                }, 2000);
            } catch (err) {
                document.execCommand('copy');
                alert("Text selected!");
            }
        };

        const closeBtn = document.createElement('button');
        closeBtn.innerText = "CLOSE";
        closeBtn.style.cssText = "width:100%; height:40px; background:#f0f0f0; color:#333; border:1px solid #ccc; border-radius:8px; font-size:14px; cursor:pointer;";
        closeBtn.onclick = () => document.body.removeChild(container);

        container.appendChild(copyBtn);
        container.appendChild(copyArea);
        container.appendChild(closeBtn);
        document.body.appendChild(container);

        try {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const safeFileName = `${deck.name.replace(/\s+/g, '_')}.csv`;
            link.setAttribute("href", url);
            link.setAttribute("download", safeFileName);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            setTimeout(() => {
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }, 100);
            alert("Export complete!");
        } catch (err) {
            console.error("Export download failed", err);
        }
    };
}
function handleSettings(selectElement) {
    const action = selectElement.value;
    
    if (action === "export") {
        // Trigger your existing export function
        if (typeof exportCurrentDeck === 'function') {
            exportCurrentDeck();
        } else {
            console.error("exportCurrentDeck function not found.");
        }
    }
    
    // Reset the dropdown back to the "Deck Options" label
    selectElement.selectedIndex = 0;
}
function toggleSettingsDropdown() {
    console.log("1. toggleSettingsDropdown function triggered.");
    
    const menu = document.getElementById('settings-menu');
    
    if (!menu) {
        console.error("ERROR: Could not find an element with id='settings-menu'. Check your HTML spelling.");
        return;
    }

    console.log("2. Current menu style.display is:", menu.style.display);

    // If display is none or empty string, show it
    if (menu.style.display === 'none' || menu.style.display === '') {
        console.log("3. Attempting to set display to 'block'");
        menu.style.display = 'block';
    } else {
        console.log("3. Attempting to set display to 'none'");
        menu.style.display = 'none';
    }
}

function downloadCSVTemplate() {
    const headers = "question,answer,phrase,notes";
    const sampleRow = "\n\"How are you?\",\"Kifa halak?\",\"Kifa halak ya sadiqi\",\"Formal greeting used for males\"";
    
    const blob = new Blob([headers + sampleRow], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "SRS_Review_Template.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function handleDeckSearch(query) {
    const overlay = document.getElementById('searchResultOverlay');
    if (!overlay) return;

    const q = query.trim().toLowerCase();
    if (!q || !currentDeck || !currentDeck.cards) {
        overlay.style.display = 'none';
        overlay.innerHTML = ''; 
        return;
    }

    let results = currentDeck.cards.filter(card => 
        (card.question && card.question.toLowerCase().includes(q)) || 
        (card.answer && card.answer.toLowerCase().includes(q))
    );

    // Keep the high-level logs so you know it's working
    console.log(`🔎 SEARCH: "${q}" | Found ${results.length} matches`);

    results.sort((a, b) => {
        const aT = (a.question || "").toLowerCase();
        const bT = (b.question || "").toLowerCase();
        if (aT.startsWith(q) && !bT.startsWith(q)) return -1;
        if (!aT.startsWith(q) && bT.startsWith(q)) return 1;
        return aT.localeCompare(bT);
    });

    overlay.innerHTML = ''; 
    
    if (results.length === 0) {
        overlay.innerHTML = '<div style="padding:10px; color:#888; background:white; text-align:center;">No matches found</div>';
    } else {
        const displayLimit = 50;
        const renderList = results.slice(0, displayLimit);

        renderList.forEach((card) => {
            // FORCE pointer to be the unique ID. 
            // If a card doesn't have an ID, we use its current index as a temporary string ID.
            const pointer = (card.id !== undefined && card.id !== null) ? card.id : "idx-" + currentDeck.cards.indexOf(card);
            
            const div = document.createElement('div');
            div.style.cssText = "display:flex; align-items:center; padding:10px; border-bottom:1px solid #eee; gap:10px; background: white; color: black;";
            div.innerHTML = `
                <span onclick="triggerSearchEdit('${pointer}')" style="flex:1; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${card.question || "Untitled"}
                </span>
                <button onclick="event.stopPropagation(); triggerSearchDelete('${pointer}')" style="background:none; border:none; font-size:18px; padding:5px;">🗑️</button>
            `;
            overlay.appendChild(div);
        });

        if (results.length > displayLimit) {
            const moreDiv = document.createElement('div');
            moreDiv.style.cssText = "padding:10px; text-align:center; color:#888; font-size:12px; background:#f9f9f9;";
            moreDiv.innerText = `... and ${results.length - displayLimit} more matches`;
            overlay.appendChild(moreDiv);
        }
    }

    overlay.style.display = 'block';
    overlay.style.zIndex = "5000";
}

// Helper to open the edit modal from search
function triggerSearchEdit(pointer) {
    // 1. Identify the ID
    const targetId = (typeof pointer === 'string' && pointer.startsWith("idx-")) 
        ? null 
        : Number(pointer);

    // 2. Go directly to the Database (Source of Truth)
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(currentDeckId);

    getReq.onsuccess = function() {
        const deck = getReq.result;
        if (!deck) return;

        // 3. Find the card in the FRESH data from the DB
        let card = null;
        let masterIndex = -1;

        if (targetId) {
            masterIndex = deck.cards.findIndex(c => Number(c.id) === targetId);
        } else {
            masterIndex = parseInt(pointer.replace("idx-", ""));
        }

        if (masterIndex !== -1) {
            card = deck.cards[masterIndex];
            
            // 4. Update Globals and UI
            editingCardIndex = masterIndex;
            editingId = card.id;
            
            // Critical: Sync the secret ID for the save function
            const secretInput = document.getElementById('editCardSecretId');
            if (secretInput) secretInput.value = card.id;

            // 5. Fill Modal
            document.getElementById('editQ').value = card.question || "";
            document.getElementById('editA').value = card.answer || "";
            document.getElementById('editN').value = card.notes || "";
            
            const phraseEl = document.getElementById('editP');
            if (phraseEl) {
                phraseEl.innerHTML = card.phrase || "";
            }

            document.getElementById('editCardModal').style.display = 'flex';
            document.getElementById('searchResultOverlay').style.display = 'none';
            document.getElementById('deckSearchInput').value = '';

            console.log("🎯 DB SYNC SUCCESS: Opened " + card.question + " (ID: " + card.id + ")");
        } else {
            alert("Card not found in database. Please refresh.");
        }
    };
}
function triggerSearchDelete(pointer) {
    let masterIndex = currentDeck.cards.findIndex(c => String(c.id) === String(pointer));
    
    if (masterIndex === -1 && currentDeck.cards[pointer]) {
        masterIndex = parseInt(pointer);
    }

    if (masterIndex !== -1 && confirm("Delete this card?")) {
        deleteCard(masterIndex);
        document.getElementById('searchResultOverlay').style.display = 'none';
        document.getElementById('deckSearchInput').value = '';
    }
}


function editSRSCard() {
    const card = currentDueCards[srsModalIndex];
    if (!card) return;

    // 1. Find the master index in the full deck
    let masterIndex = currentDeck.cards.findIndex(c => c.id === card.id);
    
    // 2. Set editing globals
    editingId = card.id;
    editingCardIndex = masterIndex; 

    // 3. Populate Edit Modal Fields
    document.getElementById('editQ').value = card.question || "";
    document.getElementById('editA').value = card.answer || "";
    
    const pField = document.getElementById('editP');
    if (pField) {
        if (pField.tagName === 'DIV') pField.innerHTML = card.phrase || "";
        else pField.value = card.phrase || "";
    }
    document.getElementById('editN').value = card.notes || "";

    // 4. UI Transition: Show Editor, Hide SRS
    const editModal = document.getElementById('editCardModal');
    if (editModal) {
        editModal.style.display = 'block';
        editModal.style.zIndex = "3000"; 
    }
    
    const srsModal = document.getElementById('srsModal');
    if (srsModal) srsModal.style.display = 'none';
}

function startTodaysReview() {
    // Safety: ensure the master list exists and actually has the filtered cards
    if (!window.todaysCardsList || window.todaysCardsList.length === 0) {
        alert("No cards reviewed today yet!");
        return;
    }

    // Grab the first 20 from the filtered master list
    todayCards = JSON.parse(JSON.stringify(window.todaysCardsList.slice(0, 20)));
    todayIdx = 0;
    showingTodayDetail = false;

    document.getElementById('todayReviewModal').style.display = 'flex';
    renderTodayCard();
}

function renderTodayCard() {
    if (todayCards.length === 0) {
        finishTodayBatch();
        return;
    }

    const card = todayCards[todayIdx];
    const isAutoReveal = document.getElementById('todayToggleDirect').checked;
    
    // Update Counter
    document.getElementById('todayCounter').innerText = `${todayCards.length} Left`;

    // Fill UI
    document.getElementById('todayQ').innerHTML = card.question || "";
    document.getElementById('todayA').innerHTML = card.answer || "";
    
    const phraseEl = document.getElementById('todayP');
    if (card.phrase && card.phrase.trim() !== "") {
        phraseEl.innerHTML = card.phrase;
        phraseEl.style.display = "block";
    } else {
        phraseEl.style.display = "none";
    }

    document.getElementById('todayPr').innerHTML = card.pronunciation || "";
    document.getElementById('todayN').innerHTML = card.notes || "";
    
    const mainBtn = document.getElementById('todayMainBtn');

    if (isAutoReveal) {
        document.getElementById('todayDetails').style.visibility = 'visible';
        mainBtn.innerText = "NEXT CARD";
        // GRAYISH for Next Card
        mainBtn.style.backgroundColor = "#666"; 
        mainBtn.style.boxShadow = "none";
        showingTodayDetail = true;
    } else {
        document.getElementById('todayDetails').style.visibility = 'hidden';
        mainBtn.innerText = "SHOW ANSWER";
        // BLACK for Show Answer
        mainBtn.style.backgroundColor = "#333"; 
        showingTodayDetail = false;
    }
}

function handleTodayAction() {
    const isAutoReveal = document.getElementById('todayToggleDirect').checked;
    
    if (!showingTodayDetail && !isAutoReveal) {
        document.getElementById('todayDetails').style.visibility = 'visible';
        document.getElementById('todayMainBtn').innerText = "DONE / NEXT";
        showingTodayDetail = true;
    } else {
        const finishedCard = todayCards[todayIdx];

        // 1. Feed the Games: Filter by question to prevent the "40 cards" duplication
        recallQueue = [finishedCard, ...recallQueue.filter(c => c.question !== finishedCard.question)];
        matchQueue = [finishedCard, ...matchQueue.filter(c => c.question !== finishedCard.question)];

        // 2. Remove from the MASTER list (The background list of ~295)
        window.todaysCardsList = window.todaysCardsList.filter(c => c.question !== finishedCard.question);

        // 3. Remove from the LOCAL batch (The current 20)
        todayCards.splice(todayIdx, 1);

        if (todayCards.length > 0) {
            // Keep index valid after splicing
            if (todayIdx >= todayCards.length) todayIdx = 0;
            renderTodayCard();
        } else {
            finishTodayBatch();
        }
    }
}
function moveTodayIdx(step) {
    if (todayCards.length === 0) return;
    
    todayIdx += step;
    // Circular navigation
    if (todayIdx >= todayCards.length) todayIdx = 0;
    if (todayIdx < 0) todayIdx = todayCards.length - 1;
    
    renderTodayCard();
}

function finishTodayBatch() {
    // 1. Update the subtitle. 
    // If this says 1860, it means window.todaysCardsList was set to the whole deck elsewhere.
    const trSub = document.getElementById('todaysCountSub');
    if (trSub) {
        // Use the filtered list length, NOT the whole deck length
        trSub.innerText = `Reviewed Today: ${window.todaysCardsList.length} Cards`;
    }

    if (window.todaysCardsList.length === 0) {
        setTimeout(() => {
            if (confirm("Today's cards are complete! Would you like to review them all again?")) {
                // This function MUST filter properly to avoid the 1860 jump
                restartTodaysReview(); 
            } else {
                closeTodayReview();
            }
        }, 300);
    } else {
        closeTodayReview();
    }
}

function closeTodayReview() {
    document.getElementById('todayReviewModal').style.display = 'none';
    
    // Refresh main screen visibility for game buttons
    const mbBtn = document.getElementById('matchBlitzBtn'); 
    const qrBtn = document.getElementById('quickRecallBtn');
    
    if (mbBtn && matchQueue.length > 0) mbBtn.style.display = 'block';
    if (qrBtn && recallQueue.length > 0) qrBtn.style.display = 'block';

    if (currentDeck) updateDeckStats(currentDeck);
}
function restartTodaysReview() {
    const now = Date.now();
    const startOfToday = new Date().setHours(0, 0, 0, 0);

    // FIX: Match the filtering logic used in openDeckDetail
    window.todaysCardsList = reviewCards.filter(c => {
        if (!c.srs || !c.srs.nextReview) return false;
        
        const level = c.srs.level || 0;
        const intervalMs = (SRS_INTERVALS[level] || 5) * 60 * 1000;
        const lastTouch = c.srs.lastReview || (c.srs.nextReview - intervalMs);
        
        // Ensure it was touched today and is scheduled forward
        return lastTouch >= startOfToday && c.srs.nextReview > now;
    });

    if (window.todaysCardsList.length > 0) {
        startTodaysReview();
    } else {
        alert("No cards were reviewed today.");
        closeTodayReview();
    }
}

function toggleCardList() {
    const modal = document.getElementById('cardListModal');
    if (!currentDeck || !currentDeck.cards) return;

    // Use 'flex' instead of 'block' to respect the layout
    modal.style.display = 'flex';
    resetAndRenderList();
}

function closeCardListModal() {
    document.getElementById('cardListModal').style.display = 'none';
}

function resetAndRenderList() {
    const isShuffle = document.getElementById('shuffleCardsToggle').checked;
    displayCards = [...currentDeck.cards];

    if (isShuffle) {
        // Ensure you have a shuffleArray function defined elsewhere
        for (let i = displayCards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [displayCards[i], displayCards[j]] = [displayCards[j], displayCards[i]];
        }
    }

    currentListPage = 0;
    renderCardListRows();
}

function renderCardListRows() {
    const container = document.getElementById('cardRowsContainer');
    const countEl = document.getElementById('cardCount');
    const indicator = document.getElementById('pageIndicator');
    
    container.innerHTML = '';
    countEl.innerText = displayCards.length;

    const start = currentListPage * cardsPerPage;
    const end = start + cardsPerPage;
    const pageSlice = displayCards.slice(start, end);
    const totalPages = Math.ceil(displayCards.length / cardsPerPage);

    indicator.innerText = `${currentListPage + 1}/${totalPages || 1}`;

    pageSlice.forEach((card, index) => {
        const row = document.createElement('div');
        // Original layout with vertical stacking for text and side-aligned delete button
        row.style = "display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #eee;";
        
        // Phrase logic: Only show the div if a phrase actually exists
        const phraseHtml = card.phrase ? 
            `<div style="font-size: 0.85em; color: #888; font-style: italic; margin-top: 2px;">${card.phrase}</div>` : '';

        row.innerHTML = `
            <div style="flex-grow: 1; margin-right: 10px;">
                <div style="font-weight: bold; color: #333; font-size: 1em;">${start + index + 1}. ${card.question}</div>
                <div style="font-size: 0.9em; color: #555; margin-top: 3px;">${card.answer}</div>
                ${phraseHtml}
            </div>
            <button onclick="deleteCard(${card.id})" style="background: none; border: none; font-size: 20px; cursor: pointer; padding: 5px;">🗑️</button>
        `;
        container.appendChild(row);
    });

    // Reset scroll to top of the list when page changes
    container.scrollTop = 0;
}

function changeListPage(delta) {
    const totalPages = Math.ceil(displayCards.length / cardsPerPage);
    const newPage = currentListPage + delta;

    if (newPage >= 0 && newPage < totalPages) {
        currentListPage = newPage;
        renderCardListRows();
    }
}

function scrollList(target) {
    const container = document.getElementById('cardRowsContainer');
    if (target === 'top') container.scrollTop = 0;
}
// Close the menu if user clicks anywhere else
window.onclick = function(event) {
    const menu = document.getElementById('settings-menu');
    // ONLY close if the click was NOT on the menu and NOT on the gear icon
    if (menu && menu.style.display === 'block') {
        if (!menu.contains(event.target) && !event.target.innerText.includes('⚙️')) {
            console.log("Window click detected: Closing menu");
            menu.style.display = 'none';
        }
    }
};

window.addEventListener('click', function(e) {
    const overlay = document.getElementById('searchResultOverlay');
    const searchInput = document.getElementById('deckSearchInput');
    
    // Only proceed if the overlay actually exists in the current HTML
    if (overlay && searchInput) {
        if (e.target !== overlay && e.target !== searchInput && !overlay.contains(e.target)) {
            overlay.style.display = 'none';
        }
    }
});

// This runs every 60 seconds to refresh the "Next: Xm" countdown
setInterval(() => {
    const listView = document.getElementById('view-list'); // Or whatever your list ID is
    const detailView = document.getElementById('view-detail');

    if (detailView.style.display !== 'none') {
        updateSRSBadge(); // Updates the specific deck you're looking at
    } else if (listView.style.display !== 'none') {
        // Optional: Refresh the list view data if you want the badges to tick live
        renderDecks(); 
    }
}, 60000); // Once a minute is plenty for the list views

