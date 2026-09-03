/* =========================================================================
   SEAT PLANNER — app.js
   Plain JS, no build step. State lives in `state`, persisted to Firestore
   (if firebase-config.js has real keys) and re-rendered on every change.
   ========================================================================= */

/* ---------------------------------------------------------------------
   State
   ------------------------------------------------------------------- */
let state = {
  students: [],   // {id, name, tags:[tagId,...]}
  tags: [],       // {id, name, color, priority:boolean}
  shapes: [],     // {id, type:'chair'|'table'|'desk', x, y, seats:[{id,dx,dy,studentId}]}
  conflicts: [],  // [ [studentIdA, studentIdB], ... ]
};

const TEACHER_DESK = { x: 79, y: 42 }; // center point of the teacher desk box (matches CSS)
const PROX_THRESHOLD = 95;             // px — freestanding seats closer than this count as "next to"
const ROOM_SIZE = 900;

let deleteMode = false;
let dragCtx = null; // {shapeId, startX, startY, origX, origY, moved}

/* ---------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function studentById(id) { return state.students.find(s => s.id === id); }
function tagById(id) { return state.tags.find(t => t.id === id); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function isConflictPair(idA, idB) {
  return state.conflicts.some(([a, b]) => (a === idA && b === idB) || (a === idB && b === idA));
}

function isStudentSeated(studentId) {
  return state.shapes.some(sh => sh.seats.some(seat => seat.studentId === studentId));
}

function findSeatOfStudent(studentId) {
  for (const sh of state.shapes) {
    for (const seat of sh.seats) {
      if (seat.studentId === studentId) return { shape: sh, seat };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------
   Shape geometry
   ------------------------------------------------------------------- */
function seatOffsets(type, count) {
  if (type === 'chair') return [{ dx: 0, dy: 0 }];
  if (type === 'table') {
    const R = 46;
    const seatDist = R + 34;
    const offsets = [];
    for (let i = 0; i < count; i++) {
      const angle = (-90 + i * (360 / count)) * (Math.PI / 180);
      offsets.push({ dx: Math.cos(angle) * seatDist, dy: Math.sin(angle) * seatDist });
    }
    return offsets;
  }
  if (type === 'desk') {
    const spacing = 70;
    const startX = -((count - 1) * spacing) / 2;
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push({ dx: startX + i * spacing, dy: 0 });
    return offsets;
  }
  return [{ dx: 0, dy: 0 }];
}

function shapeBodySize(shape) {
  if (shape.type === 'chair') return null;
  if (shape.type === 'table') { const d = (46 + 34) * 2 - 40; return { w: d, h: d }; }
  if (shape.type === 'desk') return { w: (shape.seats.length - 1) * 70 + 60, h: 56 };
  return { w: 60, h: 60 };
}

function addShape(type, seatCount) {
  const offsets = seatOffsets(type, seatCount || 1);
  const shape = {
    id: uid(),
    type,
    x: clamp(300 + Math.round((Math.random() - 0.5) * 160), 100, ROOM_SIZE - 100),
    y: clamp(320 + Math.round((Math.random() - 0.5) * 160), 100, ROOM_SIZE - 100),
    seats: offsets.map(o => ({ id: uid(), dx: o.dx, dy: o.dy, studentId: null })),
  };
  state.shapes.push(shape);
  renderShapes();
  scheduleSave();
}

/* ---------------------------------------------------------------------
   Adjacency + conflict detection
   ------------------------------------------------------------------- */
function flattenSeats() {
  const list = [];
  state.shapes.forEach(sh => {
    sh.seats.forEach((seat, idx) => {
      list.push({
        id: seat.id, shapeId: sh.id, shapeType: sh.type, index: idx,
        count: sh.seats.length, studentId: seat.studentId,
        x: sh.x + seat.dx, y: sh.y + seat.dy,
      });
    });
  });
  return list;
}

function computeAdjacentPairs(seatList) {
  const pairs = [];
  const byShape = {};
  seatList.forEach(s => { (byShape[s.shapeId] = byShape[s.shapeId] || []).push(s); });

  Object.values(byShape).forEach(group => {
    if (group[0].shapeType === 'table') {
      const n = group.length;
      for (let i = 0; i < n; i++) pairs.push([group[i].id, group[(i + 1) % n].id]);
    } else if (group[0].shapeType === 'desk') {
      for (let i = 0; i < group.length - 1; i++) pairs.push([group[i].id, group[i + 1].id]);
    }
  });

  for (let i = 0; i < seatList.length; i++) {
    for (let j = i + 1; j < seatList.length; j++) {
      const a = seatList[i], b = seatList[j];
      if (a.shapeId === b.shapeId) continue; // already handled above
      if (dist(a, b) < PROX_THRESHOLD) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

function computeConflictSeatIds() {
  const seatList = flattenSeats();
  const pairs = computeAdjacentPairs(seatList);
  const bySeatId = {};
  seatList.forEach(s => { bySeatId[s.id] = s; });
  const flagged = new Set();
  pairs.forEach(([aId, bId]) => {
    const a = bySeatId[aId], b = bySeatId[bId];
    if (a.studentId && b.studentId && isConflictPair(a.studentId, b.studentId)) {
      flagged.add(aId); flagged.add(bId);
    }
  });
  return flagged;
}

/* ---------------------------------------------------------------------
   Auto-seat
   ------------------------------------------------------------------- */
function autoSeat() {
  const seatList = flattenSeats();
  if (seatList.length === 0) { alert('Add some chairs, table groups, or desks to the room first.'); return; }
  if (state.students.length === 0) { alert('Add students to the roster first.'); return; }

  const adjacentPairs = computeAdjacentPairs(seatList);
  const priorityTagIds = new Set(state.tags.filter(t => t.priority).map(t => t.id));
  const priorityIds = state.students.filter(s => s.tags.some(t => priorityTagIds.has(t))).map(s => s.id);
  const otherIds = state.students.filter(s => !priorityIds.includes(s.id)).map(s => s.id);

  if (seatList.length < state.students.length) {
    alert(`Heads up: there are ${state.students.length} students but only ${seatList.length} seats. ${state.students.length - seatList.length} student(s) will be left unseated.`);
  }

  const byProximity = [...seatList].sort((a, b) => dist(a, TEACHER_DESK) - dist(b, TEACHER_DESK));

  let bestScore = Infinity;
  let bestAssignment = null;
  const ATTEMPTS = 400;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const slack = Math.min(seatList.length - priorityIds.length, 3);
    const pool = shuffle(byProximity.slice(0, Math.max(priorityIds.length + Math.max(slack, 0), priorityIds.length)));
    const prioritySeats = pool.slice(0, priorityIds.length);
    const prioritySeatIdSet = new Set(prioritySeats.map(s => s.id));
    const leftoverSeats = shuffle(seatList.filter(s => !prioritySeatIdSet.has(s.id)));

    const assignment = {};
    const shuffledPriorityStudents = shuffle(priorityIds);
    shuffledPriorityStudents.forEach((sid, i) => {
      if (i < prioritySeats.length) assignment[prioritySeats[i].id] = sid;
    });
    const overflowPriority = shuffledPriorityStudents.slice(prioritySeats.length);
    const restStudents = shuffle([...otherIds, ...overflowPriority]);
    restStudents.forEach((sid, i) => {
      if (i < leftoverSeats.length) assignment[leftoverSeats[i].id] = sid;
    });

    let conflictCount = 0;
    adjacentPairs.forEach(([aId, bId]) => {
      const sa = assignment[aId], sb = assignment[bId];
      if (sa && sb && isConflictPair(sa, sb)) conflictCount++;
    });

    let proxScore = 0;
    priorityIds.forEach(sid => {
      const seatId = Object.keys(assignment).find(k => assignment[k] === sid);
      if (seatId) {
        const seat = seatList.find(s => s.id === seatId);
        proxScore += dist(seat, TEACHER_DESK);
      }
    });

    const score = conflictCount * 1e6 + proxScore;
    if (score < bestScore) { bestScore = score; bestAssignment = assignment; }
    if (bestScore === 0) break;
  }

  state.shapes.forEach(sh => sh.seats.forEach(seat => { seat.studentId = null; }));
  if (bestAssignment) {
    Object.entries(bestAssignment).forEach(([seatId, studentId]) => {
      for (const sh of state.shapes) {
        const seat = sh.seats.find(s => s.id === seatId);
        if (seat) { seat.studentId = studentId; break; }
      }
    });
  }

  renderShapes();
  renderRoster();
  scheduleSave();

  const remainingConflicts = Math.floor(bestScore / 1e6);
  if (remainingConflicts > 0) {
    alert(`Seated everyone I could, but ${remainingConflicts} "can't sit together" conflict(s) could not be avoided with the current layout. Try adding more seats or spacing shapes further apart.`);
  }
}

/* ---------------------------------------------------------------------
   Rendering — Roster
   ------------------------------------------------------------------- */
function renderRoster() {
  const list = $('#studentList');
  list.innerHTML = '';
  state.students.forEach(stu => {
    const wrap = document.createElement('div');

    const chip = document.createElement('div');
    chip.className = 'student-chip' + (isStudentSeated(stu.id) ? ' seated' : '');
    chip.draggable = true;
    chip.dataset.studentId = stu.id;
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', stu.id);
    });

    const dots = document.createElement('span');
    dots.className = 'dots';
    stu.tags.forEach(tid => {
      const t = tagById(tid);
      if (!t) return;
      const d = document.createElement('span');
      d.className = 'tag-dot';
      d.style.background = t.color;
      d.title = t.name;
      dots.appendChild(d);
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = stu.name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove student';
    removeBtn.addEventListener('click', () => {
      if (!confirm(`Remove ${stu.name} from the roster?`)) return;
      state.students = state.students.filter(s => s.id !== stu.id);
      state.shapes.forEach(sh => sh.seats.forEach(seat => { if (seat.studentId === stu.id) seat.studentId = null; }));
      state.conflicts = state.conflicts.filter(([a, b]) => a !== stu.id && b !== stu.id);
      renderAll(); scheduleSave();
    });

    chip.appendChild(dots);
    chip.appendChild(name);
    chip.appendChild(removeBtn);
    wrap.appendChild(chip);

    if (state.tags.length) {
      const editRow = document.createElement('div');
      editRow.className = 'student-edit-tags';
      state.tags.forEach(t => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = stu.tags.includes(t.id);
        cb.addEventListener('change', () => {
          if (cb.checked) { if (!stu.tags.includes(t.id)) stu.tags.push(t.id); }
          else { stu.tags = stu.tags.filter(id => id !== t.id); }
          renderRoster(); renderShapes(); scheduleSave();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(t.name));
        editRow.appendChild(label);
      });
      wrap.appendChild(editRow);
    }

    list.appendChild(wrap);
  });

  renderConflictSelectors();
}

/* ---------------------------------------------------------------------
   Rendering — Tags
   ------------------------------------------------------------------- */
function renderTags() {
  const list = $('#tagList');
  list.innerHTML = '';
  state.tags.forEach(t => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.style.background = t.color;
    const label = document.createElement('span');
    label.textContent = (t.priority ? '★ ' : '') + t.name;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = 'Delete label';
    removeBtn.addEventListener('click', () => {
      if (!confirm(`Delete the "${t.name}" label?`)) return;
      state.tags = state.tags.filter(x => x.id !== t.id);
      state.students.forEach(s => { s.tags = s.tags.filter(id => id !== t.id); });
      renderAll(); scheduleSave();
    });
    pill.appendChild(label);
    pill.appendChild(removeBtn);
    list.appendChild(pill);
  });
}

/* ---------------------------------------------------------------------
   Rendering — Conflicts
   ------------------------------------------------------------------- */
function renderConflictSelectors() {
  ['#conflictA', '#conflictB'].forEach(sel => {
    const el = $(sel);
    const prev = el.value;
    el.innerHTML = '';
    state.students.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      el.appendChild(opt);
    });
    if (prev) el.value = prev;
  });
}

function renderConflictList() {
  const list = $('#conflictList');
  list.innerHTML = '';
  state.conflicts.forEach(([aId, bId], idx) => {
    const a = studentById(aId), b = studentById(bId);
    if (!a || !b) return;
    const row = document.createElement('div');
    row.className = 'conflict-row';
    const label = document.createElement('span');
    label.textContent = `${a.name} \u2194 ${b.name}`;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      state.conflicts.splice(idx, 1);
      renderConflictList(); renderShapes(); scheduleSave();
    });
    row.appendChild(label);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

/* ---------------------------------------------------------------------
   Rendering — Shapes & seats
   ------------------------------------------------------------------- */
function renderShapes() {
  const layer = $('#shapeLayer');
  layer.innerHTML = '';
  const conflictSeatIds = computeConflictSeatIds();

  state.shapes.forEach(sh => {
    const size = shapeBodySize(sh);

    if (size) {
      const body = document.createElement('div');
      body.className = `shape type-${sh.type}` + (deleteMode ? ' delete-target' : '');
      body.style.left = (sh.x - size.w / 2) + 'px';
      body.style.top = (sh.y - size.h / 2) + 'px';
      body.style.width = size.w + 'px';
      body.style.height = size.h + 'px';
      body.dataset.shapeId = sh.id;

      const bodyInner = document.createElement('div');
      bodyInner.className = 'shape-body';
      body.appendChild(bodyInner);

      const label = document.createElement('div');
      label.className = 'shape-label';
      label.textContent = sh.type === 'table' ? `Table (${sh.seats.length})` : `Desk (${sh.seats.length})`;
      body.appendChild(label);

      attachShapeDrag(body, sh.id);
      layer.appendChild(body);
    }

    sh.seats.forEach(seat => {
      const seatEl = document.createElement('div');
      seatEl.className = 'seat' + (seat.studentId ? '' : ' empty') + (conflictSeatIds.has(seat.id) ? ' conflict' : '') + (deleteMode ? ' delete-target' : '');
      seatEl.style.left = (sh.x + seat.dx) + 'px';
      seatEl.style.top = (sh.y + seat.dy) + 'px';
      seatEl.dataset.shapeId = sh.id;
      seatEl.dataset.seatId = seat.id;

      const stu = seat.studentId ? studentById(seat.studentId) : null;
      seatEl.textContent = stu ? stu.name : '';

      if (stu && stu.tags.length) {
        const dotsWrap = document.createElement('div');
        dotsWrap.className = 'tag-dots';
        stu.tags.forEach(tid => {
          const t = tagById(tid);
          if (!t) return;
          const d = document.createElement('span');
          d.className = 'd';
          d.style.background = t.color;
          d.title = t.name;
          dotsWrap.appendChild(d);
        });
        seatEl.appendChild(dotsWrap);
      }

      seatEl.addEventListener('dragover', (e) => e.preventDefault());
      seatEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const studentId = e.dataTransfer.getData('text/plain');
        if (!studentId) return;
        assignStudentToSeat(studentId, sh.id, seat.id);
      });

      attachShapeDrag(seatEl, sh.id, seat.id);
      layer.appendChild(seatEl);
    });
  });
}

function assignStudentToSeat(studentId, shapeId, seatId) {
  state.shapes.forEach(sh => sh.seats.forEach(seat => { if (seat.studentId === studentId) seat.studentId = null; }));
  const sh = state.shapes.find(s => s.id === shapeId);
  const seat = sh.seats.find(s => s.id === seatId);
  seat.studentId = studentId;
  renderShapes(); renderRoster(); scheduleSave();
}

/* ---------------------------------------------------------------------
   Drag to move shapes / click to assign / delete mode
   ------------------------------------------------------------------- */
function attachShapeDrag(el, shapeId, seatId) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const sh = state.shapes.find(s => s.id === shapeId);
    dragCtx = { shapeId, seatId, startX: e.clientX, startY: e.clientY, origX: sh.x, origY: sh.y, moved: false };
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragCtx || dragCtx.shapeId !== shapeId) return;
    const dx = e.clientX - dragCtx.startX;
    const dy = e.clientY - dragCtx.startY;
    if (Math.hypot(dx, dy) > 5) dragCtx.moved = true;
    if (!dragCtx.moved) return;
    const sh = state.shapes.find(s => s.id === shapeId);
    const room = $('#room').getBoundingClientRect();
    const scale = ROOM_SIZE / room.width;
    sh.x = clamp(dragCtx.origX + dx * scale, 20, ROOM_SIZE - 20);
    sh.y = clamp(dragCtx.origY + dy * scale, 20, ROOM_SIZE - 20);
    renderShapes();
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragCtx || dragCtx.shapeId !== shapeId) return;
    const wasClick = !dragCtx.moved;
    const clickedSeatId = dragCtx.seatId;
    dragCtx = null;
    scheduleSave();

    if (wasClick) {
      if (deleteMode) {
        if (confirm('Delete this shape and its seat(s)?')) {
          state.shapes = state.shapes.filter(s => s.id !== shapeId);
          renderAll(); scheduleSave();
        }
        return;
      }
      if (clickedSeatId) openAssignPopover(e.clientX, e.clientY, shapeId, clickedSeatId);
    }
  });
}

function openAssignPopover(clientX, clientY, shapeId, seatId) {
  const pop = $('#assignPopover');
  const select = $('#assignSelect');
  select.innerHTML = '';

  const sh = state.shapes.find(s => s.id === shapeId);
  const seat = sh.seats.find(s => s.id === seatId);

  const emptyOpt = document.createElement('option');
  emptyOpt.value = ''; emptyOpt.textContent = '— empty seat —';
  select.appendChild(emptyOpt);

  state.students.forEach(stu => {
    const opt = document.createElement('option');
    opt.value = stu.id;
    const seatedElsewhere = isStudentSeated(stu.id) && seat.studentId !== stu.id;
    opt.textContent = stu.name + (seatedElsewhere ? ' (move here)' : '');
    select.appendChild(opt);
  });
  select.value = seat.studentId || '';

  pop.style.left = Math.min(clientX, window.innerWidth - 220) + 'px';
  pop.style.top = Math.min(clientY, window.innerHeight - 60) + 'px';
  pop.classList.remove('hidden');

  select.onchange = () => {
    const val = select.value;
    if (val) assignStudentToSeat(val, shapeId, seatId);
    else {
      const s = state.shapes.find(x => x.id === shapeId).seats.find(x => x.id === seatId);
      s.studentId = null;
      renderShapes(); renderRoster(); scheduleSave();
    }
    pop.classList.add('hidden');
  };
  select.focus();
}

document.addEventListener('click', (e) => {
  const pop = $('#assignPopover');
  if (!pop.contains(e.target) && !e.target.closest('.seat')) pop.classList.add('hidden');
});

/* ---------------------------------------------------------------------
   Render-all + form wiring
   ------------------------------------------------------------------- */
function renderAll() {
  renderRoster();
  renderTags();
  renderConflictList();
  renderShapes();
}

$('#addStudentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#newStudentName');
  const name = input.value.trim();
  if (!name) return;
  state.students.push({ id: uid(), name, tags: [] });
  input.value = '';
  renderAll(); scheduleSave();
});

$('#addTagForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const nameInput = $('#newTagName');
  const colorInput = $('#newTagColor');
  const priorityInput = $('#newTagPriority');
  const name = nameInput.value.trim();
  if (!name) return;
  state.tags.push({ id: uid(), name, color: colorInput.value, priority: priorityInput.checked });
  nameInput.value = '';
  priorityInput.checked = false;
  renderAll(); scheduleSave();
});

$('#addConflictForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = $('#conflictA').value, b = $('#conflictB').value;
  if (!a || !b || a === b) return;
  if (isConflictPair(a, b)) return;
  state.conflicts.push([a, b]);
  renderConflictList(); renderShapes(); scheduleSave();
});

$('#addChairBtn').addEventListener('click', () => addShape('chair'));
$('#addTableBtn').addEventListener('click', () => {
  const n = parseInt(prompt('How many seats at this table group?', '4'), 10);
  addShape('table', clamp(isNaN(n) ? 4 : n, 3, 8));
});
$('#addDeskBtn').addEventListener('click', () => {
  const n = parseInt(prompt('How many seats at this long desk?', '3'), 10);
  addShape('desk', clamp(isNaN(n) ? 3 : n, 2, 6));
});
$('#shuffleBtn').addEventListener('click', autoSeat);
$('#clearSeatsBtn').addEventListener('click', () => {
  state.shapes.forEach(sh => sh.seats.forEach(seat => { seat.studentId = null; }));
  renderAll(); scheduleSave();
});
$('#deleteModeBtn').addEventListener('click', () => {
  deleteMode = !deleteMode;
  $('#deleteModeBtn').classList.toggle('active', deleteMode);
  renderShapes();
});

/* ---------------------------------------------------------------------
   Firebase sync (falls back to local-only mode if config is a placeholder)
   ------------------------------------------------------------------- */
let docRef = null;
let saveTimer = null;
let applyingRemote = false;

function scheduleSave() {
  if (!docRef) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (applyingRemote) return;
    docRef.set(state).catch(err => {
      console.error('Save failed', err);
      setStatus('Save failed — check console / Firestore rules', 'err');
    });
  }, 350);
}

function setStatus(text, kind) {
  const el = $('#syncStatus');
  el.textContent = text;
  el.className = 'sync-status' + (kind ? ' ' + kind : '');
}

function showLoginGate(message) {
  $('#appBody').classList.add('hidden');
  $('#loginGate').classList.remove('hidden');
  $('#signOutBtn').classList.add('hidden');
  if (message) $('#loginMessage').textContent = message;
}

function showApp() {
  $('#appBody').classList.remove('hidden');
  $('#loginGate').classList.add('hidden');
  $('#signOutBtn').classList.remove('hidden');
}

function initFirebase() {
  const isPlaceholder = !firebaseConfig || firebaseConfig.apiKey === 'YOUR_API_KEY';
  if (isPlaceholder) {
    setStatus('Local mode — edit firebase-config.js to save & sync', '');
    showApp();
    $('#signOutBtn').classList.add('hidden');
    renderAll();
    return;
  }

  try {
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const allowList = (typeof ALLOWED_EMAILS !== 'undefined' ? ALLOWED_EMAILS : []).map(e => e.toLowerCase().trim());

    $('#googleSignInBtn').addEventListener('click', () => {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(err => {
        console.error(err);
        showLoginGate('Sign-in failed. Please try again.');
      });
    });

    $('#signOutBtn').addEventListener('click', () => {
      auth.signOut();
    });

    auth.onAuthStateChanged(user => {
      if (!user) {
        docRef = null;
        showLoginGate('This app is restricted to specific Google accounts.');
        setStatus('Signed out', '');
        return;
      }

      const email = (user.email || '').toLowerCase().trim();
      const isAllowed = allowList.length === 0 || allowList.includes(email);
      if (!isAllowed) {
        docRef = null;
        showLoginGate(`${user.email} is not authorized to use this app. Ask the owner to add your email.`);
        setStatus('Not authorized', 'err');
        auth.signOut();
        return;
      }

      showApp();
      const db = firebase.firestore();
      docRef = db.collection('classrooms').doc(typeof ROOM_CODE !== 'undefined' ? ROOM_CODE : 'default');

      docRef.onSnapshot(snap => {
        if (snap.exists) {
          applyingRemote = true;
          const data = snap.data();
          state = {
            students: data.students || [],
            tags: data.tags || [],
            shapes: data.shapes || [],
            conflicts: data.conflicts || [],
          };
          renderAll();
          applyingRemote = false;
          setStatus('Synced', 'ok');
        } else {
          docRef.set(state).then(() => setStatus('Synced', 'ok'));
        }
      }, err => {
        console.error(err);
        setStatus('Sync error — check Firestore rules', 'err');
      });
    });
  } catch (err) {
    console.error(err);
    setStatus('Firebase init failed — check firebase-config.js', 'err');
    showApp();
    renderAll();
  }
}

initFirebase();
