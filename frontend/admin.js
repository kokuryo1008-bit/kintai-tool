const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
const name = localStorage.getItem('name');
const myDeptId = localStorage.getItem('department_id') ? parseInt(localStorage.getItem('department_id')) : null;
const isManager = role === 'manager';
const isSuperAdmin = role === 'admin';

if (!token || role === 'employee') { localStorage.clear(); location.href = '/'; }

document.getElementById('user-name').textContent = (isManager ? '【事業部管理者】' : '') + (name || '');

// manager は admin 権限オプションを非表示
if (isManager) {
  const adminOpt = document.getElementById('perm-admin-opt');
  if (adminOpt) adminOpt.style.display = 'none';
  // 設定・部署管理サイドバー非表示
  const navSettings = document.getElementById('nav-settings');
  if (navSettings) navSettings.style.display = 'none';
}

// 管理者・事業部管理者は打刻ウィジェット表示
document.getElementById('clock-widget').classList.remove('hidden');
setInterval(() => {
  document.getElementById('w-time').textContent = new Date().toLocaleTimeString('ja-JP');
}, 1000);
wLoadTodayStatus();

let allAttendance = [];
let allLeave = [];
let allTrips = [];
let editingEmpId = null;
let currentPin = null;

function genPin() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function regenPin() {
  currentPin = genPin();
  document.getElementById('pin-value').textContent = currentPin;
}

function resetPin() {
  const newPin = genPin();
  document.getElementById('pin-reset-value').textContent = newPin;
  currentPin = newPin;
}

// ── セクション切り替え ──
function showSection(sec) {
  ['dashboard','employees','attendance','leave','trip','shifts','reports','sales','overtime','settings'].forEach(s => {
    document.getElementById('section-' + s).classList.toggle('hidden', s !== sec);
    document.getElementById('nav-' + s).classList.toggle('active', s === sec);
  });
  if (sec === 'dashboard') loadDashboard();
  if (sec === 'employees') loadEmployees();
  if (sec === 'attendance') loadAttendance();
  if (sec === 'leave') loadLeave('pending');
  if (sec === 'trip') loadTrip('pending');
  if (sec === 'shifts') initShifts();
  if (sec === 'reports') initAdminReports();
  if (sec === 'sales') initAdminSales();
  if (sec === 'overtime') initAdminOvertime();
  if (sec === 'settings') loadSettings();
}

// ── ダッシュボード ──
async function loadDashboard() {
  try {
    const [statsRes, todayRes] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/today')
    ]);
    const stats = await statsRes.json();
    const today = await todayRes.json();

    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-label">総従業員数</div><div class="stat-value">${stats.total_employees || 0}<span class="stat-unit"> 名</span></div></div>
      <div class="stat-card"><div class="stat-label">本日出勤</div><div class="stat-value" style="color:var(--accent)">${stats.today_present || 0}<span class="stat-unit"> 名</span></div></div>
      <div class="stat-card"><div class="stat-label">有給申請中</div><div class="stat-value" style="color:var(--warning)">${stats.pending_leave || 0}<span class="stat-unit"> 件</span></div></div>
      <div class="stat-card"><div class="stat-label">出張申請中</div><div class="stat-value" style="color:var(--primary-light)">${stats.pending_trip || 0}<span class="stat-unit"> 件</span></div></div>
    `;

    const tbody = document.getElementById('today-body');
    tbody.innerHTML = '';
    (today.records || []).forEach(r => {
      const tr = document.createElement('tr');
      const statusHtml = r.clock_out
        ? '<span class="badge badge-gray">退勤済</span>'
        : r.clock_in
          ? '<span class="badge badge-green">出勤中</span>'
          : '<span class="badge badge-red">未出勤</span>';
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${r.department || '--'}</td>
        <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}</td>
        <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
        <td>${statusHtml}</td>
      `;
      tbody.appendChild(tr);
    });
    if (!today.records?.length) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
  } catch(e) {}
}

// ── 従業員管理 ──
async function loadEmployees() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    const tbody = document.getElementById('emp-body');
    tbody.innerHTML = '';
    (d.employees || []).forEach(e => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${e.employee_id}</td>
        <td>${e.name}</td>
        <td>${e.department || '--'}</td>
        <td>${e.position || '--'}</td>
        <td>${e.leave_remaining} 日</td>
        <td>
          <button class="btn-outline btn-sm" onclick="openEmpModal('${e.employee_id}')">編集</button>
          <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);margin-left:4px" onclick="deleteEmployee('${e.employee_id}','${e.name}')">削除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch(e) {}
}

async function openEmpModal(empId = null) {
  editingEmpId = empId;
  currentPin = null;
  document.getElementById('emp-modal-title').textContent = empId ? '従業員編集' : '従業員登録';
  document.getElementById('m-emp-id').value = '';
  document.getElementById('m-emp-name').value = '';
  document.getElementById('m-emp-role').value = '';
  document.getElementById('m-emp-perm').value = 'employee';
  document.getElementById('m-emp-leave').value = '10';
  document.getElementById('pin-reset-value').textContent = '';

  await loadDeptOptions('m-emp-dept');

  if (empId) {
    document.getElementById('m-emp-id').disabled = true;
    document.getElementById('pin-display').classList.add('hidden');
    document.getElementById('pin-reset').classList.remove('hidden');
    try {
      const res = await api('/api/admin/employees/' + empId);
      const e = await res.json();
      document.getElementById('m-emp-id').value = e.employee_id;
      document.getElementById('m-emp-name').value = e.name;
      document.getElementById('m-emp-role').value = e.position || '';
      document.getElementById('m-emp-perm').value = e.role;
      document.getElementById('m-emp-leave').value = e.leave_remaining;
      document.getElementById('m-emp-dept').value = e.department_id || '';
    } catch(e) {}
  } else {
    document.getElementById('m-emp-id').disabled = false;
    document.getElementById('pin-display').classList.remove('hidden');
    document.getElementById('pin-reset').classList.add('hidden');
    regenPin();
  }
  document.getElementById('emp-modal').classList.remove('hidden');
}

function closeEmpModal() {
  document.getElementById('emp-modal').classList.add('hidden');
  editingEmpId = null;
}

async function saveEmployee() {
  const empId = document.getElementById('m-emp-id').value.trim();
  const name = document.getElementById('m-emp-name').value.trim();
  if (!name) { alert('氏名を入力してください'); return; }

  if (!editingEmpId) {
    if (!/^\d{3}$/.test(empId)) { alert('社員IDは3桁の数字で入力してください（例: 001）'); return; }
    if (!currentPin) { alert('PINが生成されていません'); return; }
  }

  const body = {
    employee_id: empId,
    name,
    password: currentPin || undefined,
    department_id: document.getElementById('m-emp-dept').value ? parseInt(document.getElementById('m-emp-dept').value) : null,
    position: document.getElementById('m-emp-role').value.trim(),
    role: document.getElementById('m-emp-perm').value,
    leave_remaining: parseFloat(document.getElementById('m-emp-leave').value) || 10
  };
  try {
    const method = editingEmpId ? 'PUT' : 'POST';
    const path = editingEmpId ? '/api/admin/employees/' + editingEmpId : '/api/admin/employees';
    const res = await api(path, method, body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラーが発生しました'); return; }
    if (!editingEmpId) {
      alert(`登録完了！\n社員ID: ${empId}\nPIN: ${currentPin}\n\n従業員に伝えてください。`);
    }
    closeEmpModal();
    loadEmployees();
  } catch(e) { alert('通信エラーが発生しました'); }
}

async function deleteEmployee(empId, empName) {
  if (!confirm(`${empName} を削除しますか？`)) return;
  try {
    const res = await api('/api/admin/employees/' + empId, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    loadEmployees();
  } catch(e) { alert('通信エラー'); }
}

// ── 勤怠一覧 ──
(function initAttSelects() {
  const now = new Date();
  const ysel = document.getElementById('att-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  const msel = document.getElementById('att-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

// ── 勤怠ビュー切替 ───────────────────────────────────────────────────────────

function showAttView(mode) {
  document.getElementById('att-view-list').style.display       = mode === 'list'       ? '' : 'none';
  document.getElementById('att-view-individual').style.display = mode === 'individual' ? '' : 'none';
  document.getElementById('att-tab-list').style.background      = mode === 'list'       ? 'var(--primary)' : 'white';
  document.getElementById('att-tab-list').style.color           = mode === 'list'       ? 'white' : 'var(--text-muted)';
  document.getElementById('att-tab-individual').style.background = mode === 'individual' ? 'var(--primary)' : 'white';
  document.getElementById('att-tab-individual').style.color      = mode === 'individual' ? 'white' : 'var(--text-muted)';
  if (mode === 'individual') loadEmpCards();
}

// ── 個人別管理 ────────────────────────────────────────────────────────────────

let empCardData = [];
let selectedEmpId = null;

async function loadEmpCards() {
  if (empCardData.length) { renderEmpCards(empCardData); return; }
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    empCardData = d.employees || [];
    renderEmpCards(empCardData);
  } catch(e) {}
}

function filterEmpCards() {
  const q = document.getElementById('emp-search').value.toLowerCase();
  const filtered = empCardData.filter(e => e.name.toLowerCase().includes(q) || (e.department||'').toLowerCase().includes(q));
  renderEmpCards(filtered);
}

function renderEmpCards(emps) {
  const list = document.getElementById('emp-card-list');
  list.innerHTML = '';
  emps.forEach(e => {
    const card = document.createElement('div');
    const isSelected = e.employee_id === selectedEmpId;
    card.style.cssText = `padding:10px 14px;border-radius:10px;cursor:pointer;border:2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'};background:${isSelected ? '#EFF6FF' : 'white'};transition:.15s`;
    card.innerHTML = `
      <div style="font-weight:700;font-size:0.9rem;color:${isSelected ? 'var(--primary)' : 'var(--text)'}">${e.name}</div>
      <div style="font-size:0.75rem;color:var(--text-muted)">${e.department || '--'} ${e.position ? '/ ' + e.position : ''}</div>
      <div style="font-size:0.75rem;color:var(--accent);margin-top:2px">有給残 ${e.leave_remaining}日</div>
    `;
    card.onclick = () => selectEmployee(e.employee_id);
    list.appendChild(card);
  });
}

async function selectEmployee(empId) {
  selectedEmpId = empId;
  renderEmpCards(empCardData.filter(e => {
    const q = document.getElementById('emp-search').value.toLowerCase();
    return !q || e.name.toLowerCase().includes(q) || (e.department||'').toLowerCase().includes(q);
  }));
  await loadEmpDetail();
}

async function loadEmpDetail() {
  if (!selectedEmpId) return;
  const now = new Date();
  const panel = document.getElementById('emp-detail-panel');
  panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">読み込み中...</div>';

  const detYear  = document.getElementById('det-year');
  const detMonth = document.getElementById('det-month');
  const y = detYear?.value  || now.getFullYear();
  const m = detMonth?.value || (now.getMonth() + 1);

  try {
    const res = await api(`/api/admin/employees/${selectedEmpId}/monthly-summary?year=${y}&month=${m}`);
    const d = await res.json();
    if (!res.ok) { panel.innerHTML = '<div style="padding:20px;color:var(--danger)">エラーが発生しました</div>'; return; }
    renderEmpDetail(d, parseInt(y), parseInt(m));
  } catch(e) {
    panel.innerHTML = '<div style="padding:20px;color:var(--danger)">通信エラー</div>';
  }
}

function renderEmpDetail(data, year, month) {
  const emp = data.employee;
  const records = data.records || [];
  const now = new Date();

  const fmtMin = min => {
    if (!min) return '--';
    return Math.floor(min/60) + 'h' + (min%60 ? (min%60) + 'm' : '');
  };

  // 年月セレクト生成
  let yearOpts = '', monthOpts = '';
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 2; y--) {
    yearOpts += `<option value="${y}" ${y===year?'selected':''}>${y}年</option>`;
  }
  for (let m = 1; m <= 12; m++) {
    monthOpts += `<option value="${m}" ${m===month?'selected':''}>${m}月</option>`;
  }

  // 日付ごとの行を生成
  const daysInMonth = new Date(year, month, 0).getDate();
  const DOW = ['日','月','火','水','木','金','土'];
  const recMap = {};
  records.forEach(r => { recMap[r.date] = r; });

  let rows = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds  = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(ds).getDay();
    const r   = recMap[ds];
    const isWeekend = dow === 0 || dow === 6;
    const isToday   = ds === now.toISOString().slice(0,10);
    const rowBg = isToday ? 'background:#EFF6FF' : isWeekend ? 'background:#FAFAFA' : '';
    const dowColor = dow===0 ? 'color:#EF4444' : dow===6 ? 'color:#3B82F6' : '';
    rows += `<tr style="${rowBg}">
      <td style="white-space:nowrap;font-weight:${isToday?700:400}">${month}/${d}</td>
      <td style="${dowColor};font-weight:600">${DOW[dow]}</td>
      <td style="color:var(--accent);font-weight:600">${r?.clock_in ? r.clock_in.slice(0,5) : '<span style="color:#CBD5E0">--</span>'}</td>
      <td style="color:var(--danger)">${r?.clock_out ? r.clock_out.slice(0,5) : '<span style="color:#CBD5E0">--</span>'}</td>
      <td>${r?.work_minutes ? fmtMin(r.work_minutes) : '<span style="color:#CBD5E0">--</span>'}</td>
      <td style="color:var(--warning)">${r?.overtime_minutes ? fmtMin(r.overtime_minutes) : ''}</td>
      <td>${r ? `<button class="btn-outline btn-sm" onclick="openAttEdit(${r.id},'${r.date}','${r.clock_in||''}','${r.clock_out||''}')">修正</button>` : ''}</td>
    </tr>`;
  }

  document.getElementById('emp-detail-panel').innerHTML = `
    <!-- プロフィールヘッダー -->
    <div style="background:linear-gradient(135deg,var(--primary),var(--primary-light));color:white;border-radius:14px;padding:20px 24px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:1.4rem;font-weight:800">${emp.name}</div>
        <div style="opacity:.85;font-size:0.85rem;margin-top:4px">${emp.department||'--'} ${emp.position ? '/ '+emp.position : ''} &nbsp;|&nbsp; ID: ${emp.employee_id}</div>
      </div>
      <div style="background:rgba(255,255,255,.2);border-radius:10px;padding:10px 18px;text-align:center">
        <div style="font-size:0.75rem;opacity:.85">有給残</div>
        <div style="font-size:1.6rem;font-weight:800">${emp.leave_remaining}<span style="font-size:0.9rem">日</span></div>
      </div>
    </div>

    <!-- 月選択 -->
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <select id="det-year" style="width:auto" onchange="loadEmpDetail()">${yearOpts}</select>
      <select id="det-month" style="width:auto" onchange="loadEmpDetail()">${monthOpts}</select>
      <span style="font-size:0.82rem;color:var(--text-muted);margin-left:4px">← 変更すると自動で再表示</span>
    </div>

    <!-- サマリーカード -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
      <div class="card" style="text-align:center;padding:14px">
        <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">出勤日数</div>
        <div style="font-size:1.8rem;font-weight:800;color:var(--primary)">${data.work_days}<span style="font-size:0.9rem">日</span></div>
      </div>
      <div class="card" style="text-align:center;padding:14px">
        <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">総勤務時間</div>
        <div style="font-size:1.8rem;font-weight:800;color:var(--accent)">${fmtMin(data.total_work_minutes)}</div>
      </div>
      <div class="card" style="text-align:center;padding:14px">
        <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:4px">残業時間</div>
        <div style="font-size:1.8rem;font-weight:800;color:var(--warning)">${fmtMin(data.total_overtime_minutes)}</div>
      </div>
    </div>

    <!-- 勤怠テーブル -->
    <div class="card">
      <div class="table-wrap">
        <table style="font-size:0.85rem">
          <thead><tr><th>日付</th><th>曜日</th><th>出勤</th><th>退勤</th><th>勤務時間</th><th>残業</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function openAttEdit(attId, date, clockIn, clockOut) {
  document.getElementById('att-edit-info').textContent = date;
  document.getElementById('att-edit-in').value  = clockIn  ? clockIn.slice(0,5)  : '';
  document.getElementById('att-edit-out').value = clockOut ? clockOut.slice(0,5) : '';
  document.getElementById('att-edit-modal').classList.remove('hidden');
  document.getElementById('att-edit-modal').dataset.attId = attId;
}

async function saveAttEdit() {
  const attId   = document.getElementById('att-edit-modal').dataset.attId;
  const clockIn  = document.getElementById('att-edit-in').value;
  const clockOut = document.getElementById('att-edit-out').value;
  if (!clockIn) { alert('出勤時刻を入力してください'); return; }
  try {
    const res = await api(`/api/admin/attendance/${attId}`, 'PUT', { clock_in: clockIn + ':00', clock_out: clockOut ? clockOut + ':00' : null });
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    closeAttEdit();
    // 開いているビューを再読み込み
    if (selectedEmpId) loadEmpDetail();
    else loadAttendance();
  } catch(e) { alert('通信エラー'); }
}

function closeAttEdit() {
  document.getElementById('att-edit-modal').classList.add('hidden');
}

async function loadAttendance() {
  const year = document.getElementById('att-year').value;
  const month = document.getElementById('att-month').value;
  const dept = document.getElementById('att-dept').value;
  try {
    let url = `/api/admin/attendance?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    const res = await api(url);
    const d = await res.json();
    allAttendance = d.records || [];
    renderAttendance();
  } catch(e) {}
}

function renderAttendance() {
  const tbody = document.getElementById('att-body');
  tbody.innerHTML = '';
  allAttendance.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.date}</td>
      <td>${r.name}</td>
      <td>${r.department || '--'}</td>
      <td>${r.clock_in ? r.clock_in.slice(0,5) : '--'}</td>
      <td>${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
      <td>${r.work_minutes != null ? fmtMin(r.work_minutes) : '--'}</td>
      <td style="color:var(--warning)">${r.overtime_minutes ? fmtMin(r.overtime_minutes) : '--'}</td>
      <td><button class="btn-outline btn-sm" onclick="openAttEdit(${r.id},'${r.date}','${r.clock_in||''}','${r.clock_out||''}')">修正</button></td>
    `;
    tbody.appendChild(tr);
  });
  if (!allAttendance.length) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">データなし</td></tr>';
}



function exportCSV() {
  if (!allAttendance.length) { alert('データがありません'); return; }
  const headers = ['日付','氏名','部署','出勤','退勤','勤務時間','残業時間'];
  const rows = allAttendance.map(r => [
    r.date, r.name, r.department || '',
    r.clock_in ? r.clock_in.slice(0,5) : '',
    r.clock_out ? r.clock_out.slice(0,5) : '',
    r.work_minutes != null ? fmtMin(r.work_minutes) : '',
    r.overtime_minutes ? fmtMin(r.overtime_minutes) : ''
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `勤怠_${document.getElementById('att-year').value}_${document.getElementById('att-month').value}.csv`;
  a.click();
}

function exportMonthlySummaryCSV() {
  if (!allAttendance.length) { alert('データがありません'); return; }
  // 人別に集計
  const map = new Map();
  allAttendance.forEach(r => {
    const key = r.name + '|' + (r.department || '');
    if (!map.has(key)) {
      map.set(key, { name: r.name, department: r.department || '', days: 0, workMin: 0, otMin: 0 });
    }
    const e = map.get(key);
    if (r.clock_in) e.days++;
    e.workMin += r.work_minutes || 0;
    e.otMin += r.overtime_minutes || 0;
  });
  const year = document.getElementById('att-year').value;
  const month = document.getElementById('att-month').value;
  const headers = ['氏名','部署','出勤日数','総勤務時間','総残業時間','平均勤務時間/日'];
  const rows = [...map.values()].map(e => {
    const avgMin = e.days > 0 ? Math.round(e.workMin / e.days) : 0;
    return [
      e.name, e.department, e.days,
      fmtMinDecimal(e.workMin),
      fmtMinDecimal(e.otMin),
      fmtMinDecimal(avgMin),
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `勤怠月集計_${year}_${month}.csv`;
  a.click();
}

function fmtMinDecimal(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}:00` : `${h}:${String(m).padStart(2,'0')}`;
}

// ── 個人別Excel出力 ───────────────────────────────────────────────────────────

async function exportIndividualExcel(btn) {
  // 年月は全員一覧セレクトを使う（なければ今月）
  const now    = new Date();
  const year   = parseInt(document.getElementById('att-year')?.value  || now.getFullYear());
  const month  = parseInt(document.getElementById('att-month')?.value || (now.getMonth() + 1));
  const dept   = document.getElementById('att-dept')?.value || '';

  if (!year || !month) { alert('先に年月を選択してください'); return; }

  const origText = btn?.textContent || '📥 個人別Excel';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 作成中...'; }

  try {
    // 従業員一覧を取得
    const url = dept ? `/api/admin/employees?department_id=${dept}` : '/api/admin/employees';
    const empRes = await api(url);
    if (!empRes.ok) { alert('従業員データの取得に失敗しました'); return; }
    const empData = await empRes.json();
    const emps = empData.employees || [];
    if (!emps.length) { alert('従業員が見つかりません'); return; }

  const wb = XLSX.utils.book_new();
  const DOW = ['日','月','火','水','木','金','土'];
  const daysInMonth = new Date(year, month, 0).getDate();

  // ── 全員サマリーシート ──
  const summaryRows = [
    [`${year}年${month}月 勤怠集計`],
    [],
    ['氏名', '部署', '役職', '出勤日数', '総勤務時間', '総残業時間', '平均勤務時間', '有給残'],
  ];

  // 各従業員のデータを並列取得
  const allData = await Promise.all(emps.map(async emp => {
    try {
      const res = await api(`/api/admin/employees/${emp.employee_id}/monthly-summary?year=${year}&month=${month}`);
      return res.ok ? await res.json() : null;
    } catch(e) { return null; }
  }));

  // サマリー行を追加
  allData.forEach((d, i) => {
    if (!d) return;
    const emp = emps[i];
    summaryRows.push([
      d.employee.name,
      d.employee.department || '',
      d.employee.position   || '',
      d.work_days,
      fmtMinDecimal(d.total_work_minutes),
      fmtMinDecimal(d.total_overtime_minutes),
      d.work_days > 0 ? fmtMinDecimal(Math.round(d.total_work_minutes / d.work_days)) : '--',
      d.employee.leave_remaining + '日',
    ]);
  });

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [14,12,10,8,10,10,12,8].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsSummary, '全員集計');

  // ── 個人別シート ──
  allData.forEach((d, i) => {
    if (!d) return;
    const emp = emps[i];
    const records = d.records || [];
    const recMap  = {};
    records.forEach(r => { recMap[r.date] = r; });

    const sheetRows = [
      [`${d.employee.name} ／ ${year}年${month}月`],
      [`部署: ${d.employee.department || '--'}　役職: ${d.employee.position || '--'}　有給残: ${d.employee.leave_remaining}日`],
      [],
      [`出勤日数: ${d.work_days}日　総勤務: ${fmtMinDecimal(d.total_work_minutes)}　残業: ${fmtMinDecimal(d.total_overtime_minutes)}`],
      [],
      ['日付', '曜日', '出勤', '退勤', '勤務時間', '残業時間', '備考'],
    ];

    for (let day = 1; day <= daysInMonth; day++) {
      const ds  = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const dow = new Date(ds).getDay();
      const r   = recMap[ds];
      sheetRows.push([
        `${month}/${day}`,
        DOW[dow],
        r?.clock_in  ? r.clock_in.slice(0,5)  : '',
        r?.clock_out ? r.clock_out.slice(0,5) : '',
        r?.work_minutes     ? fmtMinDecimal(r.work_minutes)     : '',
        r?.overtime_minutes ? fmtMinDecimal(r.overtime_minutes) : '',
        '',
      ]);
    }

    // シート名はExcel禁止文字を除去し31文字以内に
    const safeName = emp.name.replace(/[[\]/:*?\\]/g, '').slice(0, 24);
    const sheetName = safeName + `_${month}月`;
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    ws['!cols'] = [8,5,7,7,9,9,14].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

    XLSX.writeFile(wb, `勤怠個人別_${year}年${month}月.xlsx`);
  } catch(e) {
    console.error(e);
    alert('Excel出力に失敗しました: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ── 有給申請管理 ──
async function loadLeave(filter = 'pending') {
  try {
    const res = await api('/api/admin/leave?status=' + (filter === 'all' ? '' : filter));
    const d = await res.json();
    allLeave = d.requests || [];
    renderLeave();
  } catch(e) {}
}

function filterLeave(f) {
  loadLeave(f);
}

function renderLeave() {
  const el = document.getElementById('leave-list');
  el.innerHTML = '';
  allLeave.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:14px;border-radius:10px;background:#F8FAFC;margin-bottom:10px;border:1px solid var(--border)';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700">${r.name}</span>
          <span style="font-size:0.82rem;color:var(--text-muted);margin-left:8px">${r.department || ''}</span>
        </div>
        <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
      </div>
      <div style="margin-top:8px;font-size:0.88rem">
        ${r.start_date} ～ ${r.end_date}（${r.days}日）
        ${r.reason ? `<span style="color:var(--text-muted)"> / ${r.reason}</span>` : ''}
      </div>
      ${r.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-primary btn-accent" style="flex:1;padding:8px;font-size:0.88rem" onclick="approveLeave(${r.id})">承認</button>
          <button class="btn-primary btn-danger" style="flex:1;padding:8px;font-size:0.88rem" onclick="rejectLeave(${r.id})">却下</button>
        </div>
      ` : ''}
    `;
    el.appendChild(div);
  });
  if (!allLeave.length) el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">申請はありません</div>';
}

async function approveLeave(id) {
  try {
    const res = await api('/api/admin/leave/' + id + '/approve', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadLeave('pending');
  } catch(e) { alert('通信エラー'); }
}

async function rejectLeave(id) {
  try {
    const res = await api('/api/admin/leave/' + id + '/reject', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadLeave('pending');
  } catch(e) { alert('通信エラー'); }
}

// ── 出張申請管理 ──
async function loadTrip(filter = 'pending') {
  try {
    const res = await api('/api/admin/trips?status=' + (filter === 'all' ? '' : filter));
    const d = await res.json();
    allTrips = d.requests || [];
    renderTrip();
  } catch(e) {}
}

function filterTrip(f) {
  loadTrip(f);
}

function renderTrip() {
  const el = document.getElementById('trip-list');
  el.innerHTML = '';
  allTrips.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:14px;border-radius:10px;background:#F8FAFC;margin-bottom:10px;border:1px solid var(--border)';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <span style="font-weight:700">${r.name}</span>
          <span style="font-size:0.82rem;color:var(--text-muted);margin-left:8px">${r.department || ''}</span>
        </div>
        <span class="badge ${statusBadge(r.status)}">${statusLabel(r.status)}</span>
      </div>
      <div style="margin-top:8px;font-size:0.88rem">
        ${r.trip_date} / ${r.destination}
        ${r.reason ? `<span style="color:var(--text-muted)"> / ${r.reason}</span>` : ''}
      </div>
      ${r.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-primary btn-accent" style="flex:1;padding:8px;font-size:0.88rem" onclick="approveTrip(${r.id})">承認</button>
          <button class="btn-primary btn-danger" style="flex:1;padding:8px;font-size:0.88rem" onclick="rejectTrip(${r.id})">却下</button>
        </div>
      ` : ''}
    `;
    el.appendChild(div);
  });
  if (!allTrips.length) el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">申請はありません</div>';
}

async function approveTrip(id) {
  try {
    const res = await api('/api/admin/trips/' + id + '/approve', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadTrip('pending');
  } catch(e) { alert('通信エラー'); }
}

async function rejectTrip(id) {
  try {
    const res = await api('/api/admin/trips/' + id + '/reject', 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    loadTrip('pending');
  } catch(e) { alert('通信エラー'); }
}

// ── 設定 ──
async function loadSettings() {
  try {
    const [compRes, deptRes] = await Promise.all([
      api('/api/company/settings'),
      api('/api/departments')
    ]);
    const comp = await compRes.json();
    if (compRes.ok) {
      document.getElementById('set-company-name').value = comp.name || '';
      document.getElementById('set-lat').value = comp.office_lat || '';
      document.getElementById('set-lon').value = comp.office_lon || '';
      document.getElementById('set-radius').value = comp.gps_radius || 500;
      document.getElementById('set-work-hours').value = comp.work_hours_per_day || 8;
      document.getElementById('set-leave-days').value = comp.default_leave_days || 10;
    }
    const depts = await deptRes.json();
    await loadDeptOptions('att-dept', true);
    renderDeptList(depts.departments || []);
  } catch(e) {}
}

function renderDeptList(depts) {
  const el = document.getElementById('dept-list');
  el.innerHTML = '';
  depts.forEach(d => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px 14px;background:#F8FAFC;border-radius:8px;margin-bottom:8px';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:600">${d.name}</span>
        <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteDept(${d.id},'${d.name}')">削除</button>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="margin:0;min-width:100px">
          <label style="font-size:0.75rem">始業時刻</label>
          <input type="time" id="dws-${d.id}" value="${d.dept_work_start||''}" style="width:110px;padding:6px 8px;font-size:0.85rem">
        </div>
        <div class="form-group" style="margin:0;min-width:100px">
          <label style="font-size:0.75rem">定時終了</label>
          <input type="time" id="dwe-${d.id}" value="${d.dept_work_end||''}" style="width:110px;padding:6px 8px;font-size:0.85rem">
        </div>
        <button class="btn-outline btn-sm" onclick="saveDeptWorkTime(${d.id})" style="margin-bottom:2px">保存</button>
        <span id="dwt-msg-${d.id}" style="font-size:0.78rem;color:var(--accent)"></span>
      </div>
    `;
    el.appendChild(div);
  });
  if (!depts.length) el.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">部署が登録されていません</div>';
}

async function saveDeptWorkTime(deptId) {
  const ws = document.getElementById(`dws-${deptId}`).value;
  const we = document.getElementById(`dwe-${deptId}`).value;
  try {
    const res = await api(`/api/departments/${deptId}/work-time`, 'PUT', { work_start: ws || null, work_end: we || null });
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    const msg = document.getElementById(`dwt-msg-${deptId}`);
    msg.textContent = '保存しました';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  } catch(e) { alert('通信エラー'); }
}

async function saveCompanySettings() {
  const body = {
    name: document.getElementById('set-company-name').value.trim(),
    office_lat: parseFloat(document.getElementById('set-lat').value) || null,
    office_lon: parseFloat(document.getElementById('set-lon').value) || null,
    gps_radius: parseInt(document.getElementById('set-radius').value) || 500
  };
  try {
    const res = await api('/api/company/settings', 'PUT', body);
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    alert('設定を保存しました');
  } catch(e) { alert('通信エラー'); }
}

async function saveWorkSettings() {
  const body = {
    work_hours_per_day: parseFloat(document.getElementById('set-work-hours').value) || 8,
    default_leave_days: parseFloat(document.getElementById('set-leave-days').value) || 10
  };
  try {
    const res = await api('/api/company/work-settings', 'PUT', body);
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    alert('設定を保存しました');
  } catch(e) { alert('通信エラー'); }
}

async function addDept() {
  const name = document.getElementById('dept-name').value.trim();
  if (!name) { alert('部署名を入力してください'); return; }
  try {
    const res = await api('/api/departments', 'POST', { name });
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    document.getElementById('dept-name').value = '';
    const deptRes = await api('/api/departments');
    const d = await deptRes.json();
    renderDeptList(d.departments || []);
    await loadDeptOptions('att-dept', true);
    await loadDeptOptions('m-emp-dept');
  } catch(e) { alert('通信エラー'); }
}

async function deleteDept(id, name) {
  if (!confirm(`部署「${name}」を削除しますか？`)) return;
  try {
    const res = await api('/api/departments/' + id, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail); return; }
    const deptRes = await api('/api/departments');
    const d = await deptRes.json();
    renderDeptList(d.departments || []);
    await loadDeptOptions('att-dept', true);
  } catch(e) { alert('通信エラー'); }
}

async function loadDeptOptions(selectId, withAll = false) {
  try {
    const res = await api('/api/departments');
    const d = await res.json();
    const sel = document.getElementById(selectId);
    const prevVal = sel.value;
    sel.innerHTML = withAll ? '<option value="">全部署</option>' : '<option value="">-- 選択 --</option>';
    (d.departments || []).forEach(dept => {
      const o = document.createElement('option');
      o.value = dept.id; o.textContent = dept.name;
      sel.appendChild(o);
    });
    sel.value = prevVal;
  } catch(e) {}
}

// ── ログアウト ──
function logout() {
  localStorage.clear();
  location.href = '/';
}

// ── ユーティリティ ──
function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { Authorization: 'Bearer ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts);
}

function fmtMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + 'h' + (m ? m + 'm' : '');
}

function statusLabel(s) {
  return { pending:'申請中', approved:'承認済', rejected:'却下' }[s] || s;
}

function statusBadge(s) {
  return { pending:'badge-yellow', approved:'badge-green', rejected:'badge-red' }[s] || 'badge-gray';
}

// ── シフト管理 ──────────────────────────────────────────────────────────────

let shiftData = [];
let shiftTemplates = [];
let shiftEmployees = [];

(function initShiftSelects() {
  const now = new Date();
  const ysel = document.getElementById('shift-year');
  for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y + '年';
    if (y === now.getFullYear()) o.selected = true;
    ysel.appendChild(o);
  }
  // 翌月まで
  for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) {
    const opt = ysel.options[0];
    if (!opt || parseInt(opt.value) < y) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      ysel.appendChild(o);
    }
  }
  const msel = document.getElementById('shift-month');
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + '月';
    if (m === now.getMonth() + 1) o.selected = true;
    msel.appendChild(o);
  }
})();

async function initShifts() {
  await Promise.all([
    loadDeptOptions('shift-dept-filter', true),
    loadDeptOptions('annual-dept', true),
    loadDeptOptions('holiday-dept-sel', false),
    loadAllDeptHolidays(),
  ]);

  // 事業部長は自部署を固定
  if (isManager && myDeptId) {
    const annDept = document.getElementById('annual-dept');
    annDept.value = myDeptId;
    annDept.disabled = true;
    document.getElementById('shift-dept-filter').value = myDeptId;
    // 定休日セレクタを非表示にして自部署を自動セット
    document.getElementById('holiday-dept-group').style.display = 'none';
    loadHolidayCheckboxes(myDeptId);
  } else {
    // 管理者は最初の部署を選択状態にする
    const hSel = document.getElementById('holiday-dept-sel');
    if (hSel.options.length > 1) {
      hSel.selectedIndex = 1;
      loadHolidayCheckboxes();
    }
  }

  const annYearSel = document.getElementById('annual-year');
  if (!annYearSel.options.length) {
    const now = new Date();
    const curFy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    for (let fy = curFy - 1; fy <= curFy + 2; fy++) {
      const o = document.createElement('option');
      o.value = fy;
      o.textContent = `${fy}年度 (${fy}年4月〜${fy+1}年3月)`;
      if (fy === curFy) o.selected = true;
      annYearSel.appendChild(o);
    }
  }

  await Promise.all([loadTemplates(), loadShiftEmployees()]);
  loadShifts();
}

async function loadShiftEmployees() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    shiftEmployees = d.employees || [];
  } catch(e) {}
}

async function loadTemplates() {
  try {
    const res = await api('/api/admin/shift-templates');
    const d = await res.json();
    shiftTemplates = d.templates || [];
    renderTemplates();
  } catch(e) {}
}

function renderTemplates() {
  const el = document.getElementById('tmpl-list');
  el.innerHTML = '';
  shiftTemplates.forEach(t => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#EFF6FF;border-radius:20px;padding:4px 12px;font-size:0.82rem;cursor:pointer;border:1px solid var(--border)';
    chip.innerHTML = `<strong>${t.name}</strong> ${t.start_time}〜${t.end_time} <span onclick="deleteTemplate(${t.id})" style="color:var(--danger);font-weight:700;padding-left:4px">×</span>`;
    el.appendChild(chip);
  });
}

async function addTemplate() {
  const name = document.getElementById('tmpl-name').value.trim();
  const start = document.getElementById('tmpl-start').value;
  const end = document.getElementById('tmpl-end').value;
  if (!name || !start || !end) { alert('全項目を入力してください'); return; }
  await api('/api/admin/shift-templates', 'POST', { name, start_time: start, end_time: end });
  document.getElementById('tmpl-name').value = '';
  loadTemplates();
}

async function deleteTemplate(id) {
  await api('/api/admin/shift-templates/' + id, 'DELETE');
  loadTemplates();
}

async function loadShifts() {
  const year = document.getElementById('shift-year').value;
  const month = document.getElementById('shift-month').value;
  const dept = document.getElementById('shift-dept-filter').value;
  try {
    let url = `/api/admin/shifts?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    const [shiftRes, empRes] = await Promise.all([api(url), api('/api/admin/employees')]);
    const shiftD = await shiftRes.json();
    const empD = await empRes.json();
    shiftData = shiftD.shifts || [];
    const emps = (empD.employees || []).filter(e => !dept || true); // フィルタは後で
    renderShiftTable(parseInt(year), parseInt(month), emps);
  } catch(e) {}
}

function renderShiftTable(year, month, emps) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_, i) => {
    const d = new Date(year, month - 1, i + 1);
    return { day: i + 1, wd: ['日','月','火','水','木','金','土'][d.getDay()], isWeekend: d.getDay() === 0 || d.getDay() === 6 };
  });
  const today = new Date().toISOString().slice(0, 10);

  // ヘッダー
  const thead = document.getElementById('shift-thead');
  thead.innerHTML = '<tr><th style="min-width:100px;position:sticky;left:0;background:#F8FAFC;z-index:1">氏名</th>' +
    days.map(d => {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
      const color = d.wd === '日' ? '#FEE2E2' : d.wd === '土' ? '#DBEAFE' : '#F8FAFC';
      const isToday = dateStr === today;
      return `<th style="min-width:70px;background:${isToday ? '#EFF6FF' : color};text-align:center;font-size:0.75rem;padding:6px 4px;${isToday ? 'border-bottom:2px solid var(--primary-light)' : ''}">
        ${d.day}<br><span style="color:${d.wd==='日'?'var(--danger)':d.wd==='土'?'var(--primary-light)':'var(--text-muted)'}">${d.wd}</span>
      </th>`;
    }).join('') + '</tr>';

  // 従業員行
  const tbody = document.getElementById('shift-tbody');
  tbody.innerHTML = '';

  // シフトデータをマップ化
  const shiftMap = {};
  shiftData.forEach(s => {
    if (!shiftMap[s.employee_id]) shiftMap[s.employee_id] = {};
    shiftMap[s.employee_id][s.shift_date] = s;
  });

  emps.forEach(emp => {
    const tr = document.createElement('tr');
    const dateStr0 = `${year}-${String(month).padStart(2,'0')}-01`;
    const empShifts = shiftMap[emp.employee_id] || {};

    tr.innerHTML = `<td style="position:sticky;left:0;background:white;z-index:1;font-weight:600;white-space:nowrap;padding:8px 12px">
      ${emp.name}<br><span style="font-size:0.75rem;color:var(--text-muted)">${emp.department || ''}</span>
    </td>` + days.map(d => {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
      const shift = empShifts[dateStr];
      const bgColor = d.wd === '日' ? '#FFF5F5' : d.wd === '土' ? '#F0F9FF' : 'white';
      if (shift) {
        return `<td style="background:${bgColor};text-align:center;padding:4px;font-size:0.75rem">
          <div style="background:#EFF6FF;border-radius:6px;padding:3px 4px;cursor:pointer" onclick="openShiftEdit('${emp.employee_id}','${emp.name}','${dateStr}','${shift.start_time}','${shift.end_time}',${shift.id})">
            <div style="font-weight:700;color:var(--primary)">${shift.start_time.slice(0,5)}</div>
            <div style="color:var(--text-muted)">${shift.end_time.slice(0,5)}</div>
          </div>
        </td>`;
      } else {
        return `<td style="background:${bgColor};text-align:center;padding:4px" onclick="openShiftEdit('${emp.employee_id}','${emp.name}','${dateStr}','','',null)">
          <div style="border:1px dashed var(--border);border-radius:6px;padding:6px;cursor:pointer;color:var(--text-muted);font-size:0.7rem">＋</div>
        </td>`;
      }
    }).join('');
    tbody.appendChild(tr);
  });

  if (!emps.length) {
    tbody.innerHTML = '<tr><td colspan="100" style="text-align:center;color:var(--text-muted);padding:20px">従業員が登録されていません</td></tr>';
  }
}

// シフト編集モーダル（インライン）
let editingShift = null;
function openShiftEdit(empId, empName, shiftDate, startTime, endTime, shiftId) {
  editingShift = { empId, shiftDate, shiftId };
  const dispDate = shiftDate.replace(/-/g, '/');

  const existing = document.getElementById('shift-edit-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'shift-edit-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:360px">
      <div class="modal-title">📅 シフト設定</div>
      <div style="font-weight:600;margin-bottom:16px">${empName} / ${dispDate}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${shiftTemplates.map(t => `
          <button class="btn-outline btn-sm" onclick="applyTemplate('${t.start_time}','${t.end_time}')">${t.name}<br><span style="font-size:0.72rem">${t.start_time}〜${t.end_time}</span></button>
        `).join('')}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0;flex:1"><label>開始</label><input type="time" id="se-start" value="${startTime || '09:00'}"></div>
        <div class="form-group" style="margin:0;flex:1"><label>終了</label><input type="time" id="se-end" value="${endTime || '18:00'}"></div>
      </div>
      <div class="modal-footer">
        ${shiftId ? `<button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteShift(${shiftId})">削除</button>` : ''}
        <button class="btn-outline" onclick="document.getElementById('shift-edit-overlay').remove()">キャンセル</button>
        <button class="btn-primary" style="width:auto;padding:10px 20px" onclick="saveShift()">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function applyTemplate(start, end) {
  document.getElementById('se-start').value = start;
  document.getElementById('se-end').value = end;
}

async function saveShift() {
  const { empId, shiftDate } = editingShift;
  const start = document.getElementById('se-start').value;
  const end = document.getElementById('se-end').value;
  if (!start || !end) { alert('時刻を入力してください'); return; }
  const res = await api('/api/admin/shifts', 'POST', {
    employee_id: empId, shift_date: shiftDate, start_time: start, end_time: end
  });
  if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
  document.getElementById('shift-edit-overlay').remove();
  loadShifts();
  if (!document.getElementById('shift-tab-annual').classList.contains('hidden')) loadAnnualCalendar();
}

async function deleteShift(shiftId) {
  if (!confirm('このシフトを削除しますか？')) return;
  await api('/api/admin/shifts/' + shiftId, 'DELETE');
  document.getElementById('shift-edit-overlay').remove();
  loadShifts();
  if (!document.getElementById('shift-tab-annual').classList.contains('hidden')) loadAnnualCalendar();
}

// ── 打刻ウィジェット ──────────────────────────────────────────────────────────

async function wLoadTodayStatus() {
  try {
    const res = await api('/api/attendance/today');
    const d = await res.json();
    const btnIn = document.getElementById('w-btn-in');
    const btnOut = document.getElementById('w-btn-out');
    const status = document.getElementById('w-status');
    if (!d.clock_in) {
      status.textContent = '未出勤';
      btnIn.disabled = false; btnOut.disabled = true;
    } else if (!d.clock_out) {
      status.textContent = `出勤中 🟢  ${d.clock_in.slice(0,5)}〜`;
      btnIn.disabled = true; btnOut.disabled = false;
    } else {
      status.textContent = `退勤済 ✅  ${d.clock_in.slice(0,5)}〜${d.clock_out.slice(0,5)}`;
      btnIn.disabled = true; btnOut.disabled = true;
    }
  } catch(e) {}
}

function wIsTrip() { return document.getElementById('w-toggle-trip').checked; }
function wUpdateTripMode() { wLoadTodayStatus(); }

async function wClockIn() {
  const btn = document.getElementById('w-btn-in');
  btn.disabled = true; btn.textContent = '処理中...';
  const body = { location_type: wIsTrip() ? 'business_trip' : 'office' };
  if (!wIsTrip()) {
    const pos = await new Promise(resolve => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(p => resolve({lat:p.coords.latitude,lon:p.coords.longitude}), () => resolve(null), {timeout:8000});
    });
    if (pos) { body.lat = pos.lat; body.lon = pos.lon; }
  }
  try {
    const res = await api('/api/attendance/clock-in', 'POST', body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); btn.disabled = false; btn.textContent = '出勤'; return; }
    wLoadTodayStatus();
  } catch(e) { alert('通信エラー'); btn.disabled = false; btn.textContent = '出勤'; }
}

async function wClockOut() {
  const btn = document.getElementById('w-btn-out');
  btn.disabled = true; btn.textContent = '処理中...';
  const body = { location_type: wIsTrip() ? 'business_trip' : 'office' };
  try {
    const res = await api('/api/attendance/clock-out', 'POST', body);
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); btn.disabled = false; btn.textContent = '退勤'; return; }
    wLoadTodayStatus();
  } catch(e) { alert('通信エラー'); btn.disabled = false; btn.textContent = '退勤'; }
}

// ── 定休日 ───────────────────────────────────────────────────────────────────

let deptHolidayMap = {};

async function loadAllDeptHolidays() {
  try {
    const res = await api('/api/departments');
    const d = await res.json();
    deptHolidayMap = {};
    (d.departments || []).forEach(dept => {
      deptHolidayMap[dept.id] = dept.weekly_off_days
        ? dept.weekly_off_days.split(',').filter(Boolean).map(Number)
        : [];
    });
  } catch(e) {}
}

function loadHolidayCheckboxes(forceDeptId) {
  const deptId = forceDeptId || parseInt(document.getElementById('holiday-dept-sel').value);
  const days = (deptId && deptHolidayMap[deptId]) ? deptHolidayMap[deptId] : [];
  for (let i = 0; i <= 6; i++) {
    const el = document.getElementById('hol-' + i);
    if (el) el.checked = days.includes(i);
  }
}

async function saveHolidays() {
  const deptId = isManager ? myDeptId : parseInt(document.getElementById('holiday-dept-sel').value);
  if (!deptId) { alert('部署を選択してください'); return; }
  const days = [];
  for (let i = 0; i <= 6; i++) {
    const el = document.getElementById('hol-' + i);
    if (el && el.checked) days.push(i);
  }
  try {
    const res = await api(`/api/departments/${deptId}/holidays`, 'PUT', { weekly_off_days: days.join(',') });
    if (!res.ok) { const d = await res.json(); alert(d.detail || 'エラー'); return; }
    deptHolidayMap[deptId] = days;
    const msg = document.getElementById('holiday-save-msg');
    msg.textContent = '保存しました';
    setTimeout(() => { msg.textContent = ''; }, 2000);
    // カレンダー表示中なら再描画
    if (!document.getElementById('shift-tab-annual').classList.contains('hidden')) {
      renderAnnualCalendar(parseInt(document.getElementById('annual-year').value));
    }
  } catch(e) { alert('通信エラー'); }
}

// ── 年間カレンダー ────────────────────────────────────────────────────────────

let annualShiftMap = {};
let annualEmps = [];
let annualCalData = null;

function showShiftTab(tab) {
  ['monthly', 'annual'].forEach(t => {
    document.getElementById('shift-tab-' + t).classList.toggle('hidden', t !== tab);
    document.getElementById('stab-' + t).classList.toggle('active', t === tab);
  });
  if (tab === 'annual') loadAnnualCalendar();
}

async function loadAnnualCalendar() {
  const fy = parseInt(document.getElementById('annual-year').value);
  const dept = document.getElementById('annual-dept').value;

  let calUrl = `/api/admin/calendar/annual?fiscal_year=${fy}`;
  if (dept) calUrl += `&department_id=${dept}`;
  let empUrl = dept ? `/api/admin/employees?department_id=${dept}` : '/api/admin/employees';

  try {
    const [calRes, empRes] = await Promise.all([api(calUrl), api(empUrl)]);
    const calD = await calRes.json();
    const empD = await empRes.json();
    annualCalData = calD;
    annualShiftMap = calD.shift_map || {};
    annualEmps = dept ? (empD.employees || []) : [];
    renderAnnualCalendar(calD);
    loadAnnualHolidays(fy);
  } catch(e) {}
}

function renderAnnualCalendar(data) {
  const grid = document.getElementById('annual-calendar-grid');
  const todayStr = new Date().toISOString().slice(0, 10);
  const natHols = data.national_holidays || {};
  const deptOff = new Set(data.dept_off_days || []);
  const mandMap = data.mandatory_map || {};
  const months  = data.months || [];

  // サマリー更新
  const sumEl = document.getElementById('annual-summary');
  sumEl.style.display = 'block';
  document.getElementById('ann-workdays').textContent = data.total_work_days ?? '--';
  document.getElementById('ann-holidays').textContent = data.total_holiday_days ?? '--';
  document.getElementById('ann-national').textContent = Object.keys(natHols).length;

  grid.innerHTML = '';

  months.forEach(({ year, month, work_days, holiday_days }) => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDow    = new Date(year, month - 1, 1).getDay();

    const card = document.createElement('div');
    card.style.cssText = 'background:white;border-radius:12px;border:1px solid var(--border);padding:14px;box-shadow:0 1px 4px rgba(0,0,0,.06)';

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)">
        <span style="font-size:0.95rem;font-weight:800;color:var(--primary)">${month}月</span>
        <span style="font-size:0.72rem;color:var(--text-muted)">${year}年</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;margin-bottom:6px">
    `;
    ['日','月','火','水','木','金','土'].forEach((d, i) => {
      const c = i===0 ? '#E53E3E' : i===6 ? '#3B82F6' : 'var(--text-muted)';
      html += `<div style="text-align:center;color:${c};font-weight:700;font-size:0.62rem;padding:2px 0">${d}</div>`;
    });

    for (let i = 0; i < firstDow; i++) html += '<div></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = (firstDow + d - 1) % 7;
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday  = dateStr === todayStr;
      const isSun    = dow === 0;
      const isSat    = dow === 6;
      const isDeptOff = deptOff.has(dow);
      const natHol   = natHols[dateStr];
      const shiftCnt = (annualShiftMap[dateStr] || []).length;
      const mandCnt  = (mandMap[dateStr] || []).length;

      let bg, nc;
      if (isToday)       { bg='#DBEAFE'; nc='var(--primary)'; }
      else if (natHol)   { bg='#FFF0F0'; nc='#C53030'; }
      else if (isDeptOff){ bg='#F1F5F9'; nc='var(--text-muted)'; }
      else if (isSun)    { bg='#FFF8F8'; nc='#E53E3E'; }
      else if (isSat)    { bg='#F0F5FF'; nc='#3B82F6'; }
      else               { bg='transparent'; nc='var(--text)'; }

      let badge;
      if (shiftCnt > 0) {
        badge = `<div style="background:var(--accent);color:white;border-radius:3px;font-size:0.58rem;font-weight:700;line-height:13px">${shiftCnt}</div>`;
      } else if (natHol) {
        badge = `<div style="font-size:0.55rem;color:#C53030;line-height:13px" title="${natHol.name}">祝</div>`;
      } else if (isDeptOff) {
        badge = `<div style="font-size:0.55rem;color:var(--text-muted);line-height:13px">休</div>`;
      } else {
        badge = '<div style="height:13px"></div>';
      }
      if (mandCnt > 0) {
        badge += `<div style="background:#10B981;color:white;border-radius:2px;font-size:0.5rem;font-weight:700;line-height:11px">有</div>`;
      }

      const tip = natHol ? `${dateStr}（${natHol.name}）` : dateStr;
      html += `<div onclick="openDayPanel('${dateStr}')" title="${tip}" style="text-align:center;padding:2px 1px;border-radius:4px;cursor:pointer;background:${bg}">
        <div style="color:${nc};font-weight:${isToday?700:400};font-size:0.68rem">${d}</div>
        ${badge}
      </div>`;
    }
    html += `</div>
      <div style="display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid var(--border);font-size:0.74rem">
        <span style="color:var(--primary);font-weight:700">出勤 ${work_days}日</span>
        <span style="color:var(--text-muted)">休日 ${holiday_days}日</span>
      </div>`;
    card.innerHTML = html;
    grid.appendChild(card);
  });
}

// ── 祝日管理 ─────────────────────────────────────────────────────────────────

async function loadAnnualHolidays(fy) {
  const fiscalYear = fy ?? parseInt(document.getElementById('annual-year').value);
  try {
    const res = await api(`/api/admin/holidays?fiscal_year=${fiscalYear}`);
    const d = await res.json();
    const list = document.getElementById('nhol-list');
    list.innerHTML = '';
    const hols = d.holidays || [];
    if (!hols.length) {
      list.innerHTML = '<span style="font-size:0.82rem;color:var(--text-muted)">祝日未登録。「国民の祝日を自動インポート」で一括登録できます。</span>';
      return;
    }
    hols.forEach(h => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#FFF5F5;border:1px solid #FEB2B2;border-radius:16px;padding:3px 10px;font-size:0.76rem;color:#C53030';
      chip.innerHTML = `${h.holiday_date} ${h.name} <span onclick="deleteNationalHoliday(${h.id})" style="cursor:pointer;font-weight:700;color:#E53E3E">×</span>`;
      list.appendChild(chip);
    });
  } catch(e) {}
}

async function addNationalHoliday() {
  const dt = document.getElementById('nhol-date').value;
  const name = document.getElementById('nhol-name').value.trim();
  if (!dt || !name) { alert('日付と名称を入力してください'); return; }
  await api('/api/admin/holidays', 'POST', { holiday_date: dt, name });
  document.getElementById('nhol-date').value = '';
  document.getElementById('nhol-name').value = '';
  const fy = parseInt(document.getElementById('annual-year').value);
  loadAnnualHolidays(fy);
}

async function deleteNationalHoliday(id) {
  await api(`/api/admin/holidays/${id}`, 'DELETE');
  const fy = parseInt(document.getElementById('annual-year').value);
  loadAnnualHolidays(fy);
}

async function importJpHolidays() {
  const fy = parseInt(document.getElementById('annual-year').value);
  const res = await api('/api/admin/holidays/import', 'POST', { fiscal_year: fy });
  const d = await res.json();
  alert(`${d.count || 0}件の国民の祝日をインポートしました`);
  loadAnnualHolidays(fy);
  loadAnnualCalendar();
}

// ── 年5日有給取得義務 ─────────────────────────────────────────────────────────

let mlSelectedDates = new Set();
let mlNatHols = {};
let mlDeptOff = new Set();
let mlMode = 'individual';

function setMlMode(mode) {
  mlMode = mode;
  const isIndividual = mode === 'individual';
  document.getElementById('ml-tab-individual').style.cssText += `;background:${isIndividual?'var(--primary)':'white'};color:${isIndividual?'white':'var(--text-muted)'}`;
  document.getElementById('ml-tab-bulk').style.cssText += `;background:${isIndividual?'white':'var(--primary)'};color:${isIndividual?'var(--text-muted)':'white'}`;
  document.getElementById('ml-row-individual').style.display = isIndividual ? 'flex' : 'none';
  document.getElementById('ml-row-bulk').style.display      = isIndividual ? 'none' : 'flex';
  document.getElementById('ml-bulk-warning').style.display  = isIndividual ? 'none' : 'block';
  mlSelectedDates.clear();
  document.getElementById('ml-calendar-grid').innerHTML = '';
  updateMlCount();
}

async function openMandatoryModal() {
  const fy   = parseInt(document.getElementById('annual-year').value);
  const dept = document.getElementById('annual-dept').value;
  mlNatHols = annualCalData ? (annualCalData.national_holidays || {}) : {};
  mlDeptOff = annualCalData ? new Set(annualCalData.dept_off_days || []) : new Set();

  // 個別 — 従業員セレクタ
  const empSel = document.getElementById('ml-emp-sel');
  empSel.innerHTML = '<option value="">-- 従業員を選択 --</option>';
  shiftEmployees
    .filter(e => !dept || String(e.department_id) === dept)
    .forEach(e => {
      const o = document.createElement('option');
      o.value = e.employee_id;
      o.textContent = `${e.name}（${e.department || '--'}）`;
      empSel.appendChild(o);
    });

  // 部署一括 — 部署セレクタ
  const deptSel = document.getElementById('ml-dept-sel');
  deptSel.innerHTML = '<option value="">-- 部署を選択 --</option>';
  try {
    const res = await api('/api/departments');
    const d = await res.json();
    (d.departments || []).forEach(dep => {
      const o = document.createElement('option');
      o.value = dep.id;
      o.textContent = dep.name;
      if (dept && String(dep.id) === dept) o.selected = true;
      deptSel.appendChild(o);
    });
  } catch(e) {}

  mlSelectedDates.clear();
  document.getElementById('ml-calendar-grid').innerHTML = '';
  // モードリセット
  setMlMode('individual');
  updateMlCount();
  document.getElementById('mandatory-modal').classList.remove('hidden');
}

function closeMandatoryModal() {
  document.getElementById('mandatory-modal').classList.add('hidden');
}

async function onMlEmpChange() {
  const empId = document.getElementById('ml-emp-sel').value;
  const fy    = parseInt(document.getElementById('annual-year').value);
  mlSelectedDates.clear();
  if (empId) {
    try {
      const res = await api(`/api/admin/mandatory-leaves?fiscal_year=${fy}&employee_id=${empId}`);
      const d = await res.json();
      const ml = (d.mandatory_leaves || {})[empId];
      if (ml) ml.dates.forEach(dt => mlSelectedDates.add(dt));
    } catch(e) {}
  }
  renderMlCalendar(fy);
}

function onMlDeptChange() {
  // 部署一括は白紙からスタート
  mlSelectedDates.clear();
  const fy = parseInt(document.getElementById('annual-year').value);
  renderMlCalendar(fy);
}

function renderMlCalendar(fy) {
  const grid = document.getElementById('ml-calendar-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const mo = i < 9 ? 4 + i : 4 + i - 12;
    const yr = mo >= 4 ? fy : fy + 1;
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const firstDow = new Date(yr, mo - 1, 1).getDay();
    const card = document.createElement('div');
    card.style.cssText = 'background:#F8FAFC;border-radius:8px;padding:8px;border:1px solid var(--border)';
    let html = `<div style="font-size:0.82rem;font-weight:700;color:var(--primary);margin-bottom:5px">${yr}年${mo}月</div>`;
    html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px">';
    ['日','月','火','水','木','金','土'].forEach((d, i) => {
      const c = i===0?'#E53E3E':i===6?'#3B82F6':'var(--text-muted)';
      html += `<div style="text-align:center;font-size:0.6rem;color:${c};font-weight:600">${d}</div>`;
    });
    for (let i = 0; i < firstDow; i++) html += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = (firstDow + d - 1) % 7;
      const ds = `${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isSun    = dow === 0;
      const isSat    = dow === 6;
      const isNatHol = !!mlNatHols[ds];
      const isSel    = mlSelectedDates.has(ds);
      if (isNatHol) {
        // 祝日のみ選択不可
        html += `<div style="text-align:center;font-size:0.6rem;color:#FCA5A5;padding:1px" title="${mlNatHols[ds].name}">${d}</div>`;
      } else {
        const bg = isSel ? '#10B981' : '#fff';
        const tc = isSel ? 'white' : isSun ? '#E53E3E' : isSat ? '#3B82F6' : 'var(--text)';
        const border = isSel ? '#10B981' : '#E2E8F0';
        html += `<div onclick="toggleMlDate('${ds}',${fy})" style="text-align:center;font-size:0.62rem;background:${bg};color:${tc};border-radius:3px;padding:2px 1px;cursor:pointer;border:1px solid ${border}">${d}</div>`;
      }
    }
    html += '</div>';
    card.innerHTML = html;
    grid.appendChild(card);
  }
  updateMlCount();
}

function toggleMlDate(ds, fy) {
  if (mlSelectedDates.has(ds)) mlSelectedDates.delete(ds);
  else mlSelectedDates.add(ds);
  renderMlCalendar(fy);
}

function updateMlCount() {
  const cnt = mlSelectedDates.size;
  const text = `${cnt}日 / 5日必要`;
  const bg   = cnt >= 5 ? '#ECFDF5' : '#EFF6FF';
  const col  = cnt >= 5 ? '#059669' : 'var(--primary)';
  ['ml-count-badge', 'ml-count-badge-bulk'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.style.background = bg; el.style.color = col; }
  });
}

function updateMlCountBulk() {
  const cnt   = mlSelectedDates.size;
  const badge = document.getElementById('ml-count-badge-bulk');
  if (!badge) return;
  badge.textContent = `${cnt}日 / 5日必要`;
  badge.style.background = cnt >= 5 ? '#ECFDF5' : '#EFF6FF';
  badge.style.color      = cnt >= 5 ? '#059669' : 'var(--primary)';
}

async function saveMandatoryLeaves() {
  const fy    = parseInt(document.getElementById('annual-year').value);
  const dates = [...mlSelectedDates].sort();

  if (mlMode === 'bulk') {
    const deptId = document.getElementById('ml-dept-sel').value;
    if (!deptId) { alert('部署を選択してください'); return; }
    try {
      const res = await api('/api/admin/mandatory-leaves/bulk', 'POST', {
        department_id: parseInt(deptId), fiscal_year: fy, dates
      });
      const d = await res.json();
      alert(`${d.employee_count}名 × ${dates.length}日分の義務有給を一括登録しました`);
      closeMandatoryModal();
      loadAnnualCalendar();
    } catch(e) { alert('保存に失敗しました'); }
  } else {
    const empId = document.getElementById('ml-emp-sel').value;
    if (!empId) { alert('従業員を選択してください'); return; }
    try {
      await api('/api/admin/mandatory-leaves', 'POST', { employee_id: empId, fiscal_year: fy, dates });
      alert(`${dates.length}日分の義務有給を登録しました`);
      closeMandatoryModal();
      loadAnnualCalendar();
    } catch(e) { alert('保存に失敗しました'); }
  }
}

function openDayPanel(dateStr) {
  const dayShifts = annualShiftMap[dateStr] || [];
  const [y, mo, d] = dateStr.split('-');
  const dow = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d)).getDay();
  const dispDate = `${y}年${parseInt(mo)}月${parseInt(d)}日（${'日月火水木金土'[dow]}）`;

  const existing = document.getElementById('day-panel-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'day-panel-overlay';
  overlay.className = 'modal-overlay';

  let rows;
  if (annualEmps.length) {
    const shiftByEmp = {};
    dayShifts.forEach(s => { shiftByEmp[s.employee_id] = s; });
    rows = annualEmps.map(emp => {
      const s = shiftByEmp[emp.employee_id];
      return s
        ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#EFF6FF;border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="closeDayAndEdit('${emp.employee_id}','${escQ(emp.name)}','${dateStr}','${s.start_time}','${s.end_time}',${s.id})">
            <span style="font-weight:600">${emp.name}</span>
            <span style="color:var(--primary);font-weight:700">${s.start_time.slice(0,5)}〜${s.end_time.slice(0,5)}</span>
           </div>`
        : `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#F8FAFC;border-radius:8px;margin-bottom:6px;cursor:pointer;border:1px dashed var(--border)" onclick="closeDayAndEdit('${emp.employee_id}','${escQ(emp.name)}','${dateStr}','','',null)">
            <span style="color:var(--text-muted)">${emp.name}</span>
            <span style="font-size:0.8rem;color:var(--text-muted)">＋ 追加</span>
           </div>`;
    }).join('');
  } else {
    rows = dayShifts.length
      ? dayShifts.map(s =>
          `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#EFF6FF;border-radius:8px;margin-bottom:6px;cursor:pointer" onclick="closeDayAndEdit('${s.employee_id}','${escQ(s.name)}','${dateStr}','${s.start_time}','${s.end_time}',${s.id})">
            <div><span style="font-weight:600">${s.name}</span><span style="font-size:0.78rem;color:var(--text-muted);margin-left:8px">${s.department||''}</span></div>
            <span style="color:var(--primary);font-weight:700">${s.start_time.slice(0,5)}〜${s.end_time.slice(0,5)}</span>
           </div>`
        ).join('')
      : '<div style="text-align:center;color:var(--text-muted);padding:24px">この日のシフトはありません</div>';
  }

  overlay.innerHTML = `
    <div class="modal" style="max-width:420px;max-height:80vh;overflow-y:auto">
      <div class="modal-title">📅 ${dispDate}</div>
      ${dayShifts.length ? `<div style="margin-bottom:12px;font-size:0.83rem;color:var(--text-muted)">${dayShifts.length}名登録済み</div>` : ''}
      ${rows}
      <div class="modal-footer"><button class="btn-outline" onclick="document.getElementById('day-panel-overlay').remove()">閉じる</button></div>
    </div>`;
  document.body.appendChild(overlay);
}

function closeDayAndEdit(empId, empName, shiftDate, startTime, endTime, shiftId) {
  document.getElementById('day-panel-overlay').remove();
  openShiftEdit(empId, empName, shiftDate, startTime, endTime, shiftId);
}

function escQ(str) { return str.replace(/'/g, "\\'"); }

// ── Excel出力（月別シフト表） ─────────────────────────────────────────────────

function exportAdminShiftExcel() {
  if (!shiftData || !shiftData.length) { alert('シフトデータがありません。先に「表示」ボタンを押してください。'); return; }
  const year = parseInt(document.getElementById('shift-year').value);
  const month = parseInt(document.getElementById('shift-month').value);
  const daysInMonth = new Date(year, month, 0).getDate();
  const DOW = ['日','月','火','水','木','金','土'];

  const header = ['氏名', '部署'];
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    header.push(`${d}(${DOW[dt.getDay()]})`);
  }

  const empMap = {};
  shiftData.forEach(s => {
    if (!empMap[s.employee_id]) empMap[s.employee_id] = { name: s.name, department: s.department || '', dates: {} };
    empMap[s.employee_id].dates[s.shift_date] = `${s.start_time.slice(0,5)}~${s.end_time.slice(0,5)}`;
  });

  const rows = [header];
  Object.values(empMap).forEach(emp => {
    const row = [emp.name, emp.department];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      row.push(emp.dates[dateStr] || '');
    }
    rows.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, ...Array(daysInMonth).fill({ wch: 9 })];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${year}年${month}月`);
  XLSX.writeFile(wb, `シフト表_${year}年${month}月.xlsx`);
}

// ── Excel出力（年間カレンダー） ───────────────────────────────────────────────

function exportAnnualExcel() {
  if (!annualCalData) { alert('年間カレンダーデータがありません。先に「表示」ボタンを押してください。'); return; }
  const fy = parseInt(document.getElementById('annual-year').value);
  const natHols = annualCalData.national_holidays || {};
  const deptOff = new Set(annualCalData.dept_off_days || []);
  const DOW = ['日','月','火','水','木','金','土'];

  const wb = XLSX.utils.book_new();

  // 年間サマリーシート
  const summaryRows = [
    [`${fy}年度 年間カレンダー`],
    [],
    ['月', '出勤日数', '休日日数'],
  ];
  (annualCalData.months || []).forEach(m => {
    summaryRows.push([`${m.year}年${m.month}月`, m.work_days, m.holiday_days]);
  });
  summaryRows.push([]);
  summaryRows.push(['合計', annualCalData.total_work_days, annualCalData.total_holiday_days]);
  summaryRows.push([]);
  summaryRows.push(['祝日一覧']);
  summaryRows.push(['日付', '名称']);
  Object.entries(natHols).sort().forEach(([ds, h]) => {
    summaryRows.push([ds, h.name]);
  });

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'サマリー');

  // 月別シートを作成
  (annualCalData.months || []).forEach(({ year, month, work_days, holiday_days }) => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const rows = [];

    // ヘッダー
    const dayRow = [''];
    const dowRow = [''];
    const typeRow = [''];
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(year, month - 1, d);
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      dayRow.push(d);
      dowRow.push(DOW[dt.getDay()]);
      if (natHols[dateStr]) typeRow.push('祝');
      else if (deptOff.has(dt.getDay())) typeRow.push('休');
      else if (dt.getDay() === 0) typeRow.push('日');
      else if (dt.getDay() === 6) typeRow.push('土');
      else typeRow.push('');
    }
    rows.push(dayRow);
    rows.push(dowRow);
    rows.push(typeRow);

    // 従業員シフト行
    const shifts = annualShiftMap || {};
    const empMap = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      (shifts[dateStr] || []).forEach(s => {
        if (!empMap[s.employee_id]) empMap[s.employee_id] = { name: s.name, dates: {} };
        empMap[s.employee_id].dates[dateStr] = `${s.start_time.slice(0,5)}~${s.end_time.slice(0,5)}`;
      });
    }
    Object.values(empMap).forEach(emp => {
      const row = [emp.name];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        row.push(emp.dates[dateStr] || '');
      }
      rows.push(row);
    });

    rows.push([`出勤日数: ${work_days}日 / 休日日数: ${holiday_days}日`]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, ...Array(daysInMonth).fill({ wch: 8 })];
    XLSX.utils.book_append_sheet(wb, ws, `${month}月`);
  });

  XLSX.writeFile(wb, `年間カレンダー_${fy}年度.xlsx`);
}

// ── 一括シフト登録 ────────────────────────────────────────────────────────────

let bulkSelectedDates = new Set();
let bulkEmpDeptId = null;
let _bulkTemplate = null;

function openBulkModal() {
  // 従業員セレクタ
  const sel = document.getElementById('bulk-emp-sel');
  sel.innerHTML = '<option value="">-- 従業員を選択 --</option>';
  shiftEmployees.forEach(e => {
    const o = document.createElement('option');
    o.value = e.employee_id;
    o.textContent = `${e.name}（${e.department || '--'}）`;
    o.dataset.deptId = e.department_id || '';
    sel.appendChild(o);
  });

  // 年月セレクタ（初期化は1回のみ）
  const bYear = document.getElementById('bulk-year');
  const bMonth = document.getElementById('bulk-month');
  if (!bYear.options.length) {
    const now = new Date();
    for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      if (y === now.getFullYear()) o.selected = true;
      bYear.appendChild(o);
    }
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m + '月';
      if (m === now.getMonth() + 1) o.selected = true;
      bMonth.appendChild(o);
    }
  }

  renderBulkTemplates();
  _bulkTemplate = null;
  bulkEmpDeptId = null;
  bulkSelectedDates = new Set();
  document.getElementById('bulk-calendar').innerHTML =
    '<div style="text-align:center;color:var(--text-muted);padding:24px">従業員とテンプレートを選択してください</div>';
  document.getElementById('bulk-count').textContent = '0';
  document.getElementById('bulk-shift-modal').classList.remove('hidden');
}

function renderBulkTemplates() {
  const el = document.getElementById('bulk-tmpl-list');
  el.innerHTML = '';
  shiftTemplates.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'btn-outline btn-sm';
    btn.id = `btmpl-${t.id}`;
    btn.innerHTML = `<strong>${t.name}</strong>&nbsp;${t.start_time.slice(0,5)}〜${t.end_time.slice(0,5)}`;
    btn.onclick = () => selectBulkTemplate(t);
    el.appendChild(btn);
  });
}

function selectBulkTemplate(tmpl) {
  _bulkTemplate = tmpl;
  document.querySelectorAll('[id^="btmpl-"]').forEach(b => {
    const active = b.id === `btmpl-${tmpl.id}`;
    b.style.background = active ? 'var(--primary)' : '';
    b.style.color = active ? 'white' : '';
    b.style.borderColor = active ? 'var(--primary)' : '';
  });
  if (document.getElementById('bulk-emp-sel').value) initBulkCalendar();
}

function onBulkEmpChange() {
  const opt = document.getElementById('bulk-emp-sel').selectedOptions[0];
  bulkEmpDeptId = opt && opt.dataset.deptId ? parseInt(opt.dataset.deptId) : null;
  initBulkCalendar();
}

function initBulkCalendar() {
  if (!document.getElementById('bulk-emp-sel').value) return;
  const year = parseInt(document.getElementById('bulk-year').value);
  const month = parseInt(document.getElementById('bulk-month').value);
  const holidays = bulkEmpDeptId && deptHolidayMap[bulkEmpDeptId] ? deptHolidayMap[bulkEmpDeptId] : [];
  const daysInMonth = new Date(year, month, 0).getDate();

  bulkSelectedDates = new Set();
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (!holidays.includes(dow)) {
      bulkSelectedDates.add(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
  }
  renderBulkCalendar();
}

function renderBulkCalendar() {
  const year = parseInt(document.getElementById('bulk-year').value);
  const month = parseInt(document.getElementById('bulk-month').value);
  const holidays = bulkEmpDeptId && deptHolidayMap[bulkEmpDeptId] ? deptHolidayMap[bulkEmpDeptId] : [];
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const today = new Date().toISOString().slice(0, 10);

  let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">';
  ['日','月','火','水','木','金','土'].forEach((d, i) => {
    const c = i===0 ? 'var(--danger)' : i===6 ? 'var(--primary-light)' : 'var(--text-muted)';
    html += `<div style="text-align:center;color:${c};font-weight:700;font-size:0.75rem;padding:4px 0">${d}</div>`;
  });

  for (let i = 0; i < firstDow; i++) html += '<div></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = (firstDow + d - 1) % 7;
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isHoliday = holidays.includes(dow);
    const isSelected = bulkSelectedDates.has(dateStr);
    const isToday = dateStr === today;
    const isSun = dow === 0, isSat = dow === 6;

    let bg, color, border;
    if (isHoliday) {
      bg = '#F1F5F9'; color = '#94A3B8'; border = '1px solid #E2E8F0';
    } else if (isSelected) {
      bg = 'var(--accent)'; color = 'white'; border = '1px solid var(--accent)';
    } else {
      bg = 'white';
      color = isSun ? 'var(--danger)' : isSat ? 'var(--primary-light)' : 'var(--text)';
      border = '1px solid var(--border)';
    }

    html += `<div onclick="${isHoliday ? '' : `toggleBulkDate('${dateStr}')`}"
      style="text-align:center;padding:7px 2px;border-radius:6px;cursor:${isHoliday?'default':'pointer'};background:${bg};color:${color};border:${border};font-size:0.82rem;font-weight:${isToday?700:400}">
      ${d}${isHoliday ? '<div style="font-size:0.58rem;opacity:.7;line-height:1.2">休</div>' : ''}
    </div>`;
  }

  html += '</div>';
  document.getElementById('bulk-calendar').innerHTML = html;
  document.getElementById('bulk-count').textContent = bulkSelectedDates.size;
}

function toggleBulkDate(dateStr) {
  if (bulkSelectedDates.has(dateStr)) bulkSelectedDates.delete(dateStr);
  else bulkSelectedDates.add(dateStr);
  renderBulkCalendar();
}

function resetBulkSelection() { initBulkCalendar(); }

async function saveBulkShifts() {
  const empId = document.getElementById('bulk-emp-sel').value;
  if (!empId) { alert('従業員を選択してください'); return; }
  if (!_bulkTemplate) { alert('テンプレートを選択してください'); return; }
  if (!bulkSelectedDates.size) { alert('出勤日を選択してください'); return; }
  if (!confirm(`${bulkSelectedDates.size}日分のシフトを登録しますか？\n（既存のシフトは上書きされます）`)) return;
  try {
    const res = await api('/api/admin/shifts/bulk', 'POST', {
      employee_id: empId,
      dates: [...bulkSelectedDates].sort(),
      start_time: _bulkTemplate.start_time,
      end_time: _bulkTemplate.end_time,
    });
    const d = await res.json();
    if (!res.ok) { alert(d.detail || 'エラー'); return; }
    document.getElementById('bulk-shift-modal').classList.add('hidden');
    loadShifts();
    if (!document.getElementById('shift-tab-annual').classList.contains('hidden')) loadAnnualCalendar();
    alert(`${d.count}日分のシフトを登録しました`);
  } catch(e) { alert('通信エラー'); }
}

// ── 日報閲覧 ──────────────────────────────────────────────────────────────────

const ADM_WORK_CODES = [
  ['A','部品検品・部品注文・払出・部品確認'],
  ['B','タクト図面,プログラム作成・確認'],
  ['C','部品セッティング(SMD/手載せ)'],
  ['D','SMD/手載せ/リフロー（1st）'],
  ['E','SMD/手載せ/リフロー（2nd）'],
  ['F','部品前準備・DIP部品加工'],
  ['G','マスキングテープ貼り・シール貼り(作成)'],
  ['H','手挿入・自動半田DIP'],
  ['I','後付け・組立・改造'],
  ['J','製品仕上げ(リードカット、清掃)'],
  ['K','初品検査/製品出荷検査'],
  ['L','修正'],
  ['M','返却部品の確認・梱包・伝票処理・発送'],
  ['N','作業指導'],
  ['O','棚卸'],
];

let allAdminReports = [];

async function initAdminReports() {
  const ysel = document.getElementById('rep-adm-year');
  if (!ysel.options.length) {
    const now = new Date();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      if (y === now.getFullYear()) o.selected = true;
      ysel.appendChild(o);
    }
    const msel = document.getElementById('rep-adm-month');
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m + '月';
      if (m === now.getMonth() + 1) o.selected = true;
      msel.appendChild(o);
    }
  }
  await loadDeptOptions('rep-adm-dept', true);
  await loadReportEmpOptions();
  loadAdminReports();
}

async function loadReportEmpOptions() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    const sel = document.getElementById('rep-adm-emp');
    sel.innerHTML = '<option value="">全員</option>';
    (d.employees || []).forEach(e => {
      const o = document.createElement('option');
      o.value = e.employee_id;
      o.textContent = `${e.name}（${e.department || '--'}）`;
      sel.appendChild(o);
    });
  } catch(e) {}
}

async function loadAdminReports() {
  const year = document.getElementById('rep-adm-year').value;
  const month = document.getElementById('rep-adm-month').value;
  const dept = document.getElementById('rep-adm-dept').value;
  const emp = document.getElementById('rep-adm-emp').value;
  try {
    let url = `/api/admin/reports?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    if (emp) url += `&employee_id=${emp}`;
    const res = await api(url);
    const d = await res.json();
    allAdminReports = d.entries || [];
    renderAdminReports();
  } catch(e) {}
}

function renderAdminReports() {
  const tbody = document.getElementById('rep-adm-body');
  const tfoot = document.getElementById('rep-adm-foot');
  tbody.innerHTML = '';
  if (!allAdminReports.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">データなし</td></tr>';
    tfoot.innerHTML = '';
    return;
  }
  let totalBoard = 0, totalOther = 0;
  allAdminReports.forEach(r => {
    const bMin = calcRepMin(r.board_start, r.board_end);
    const oMin = calcRepMin(r.other_start, r.other_end);
    totalBoard += bMin;
    totalOther += oMin;
    const codeLabel = (code) => {
      if (!code) return '--';
      const e = ADM_WORK_CODES.find(([c]) => c === code);
      return e ? `<span style="font-weight:700">${e[0]}</span> ${e[1]}` : code;
    };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${r.report_date}</td>
      <td style="font-weight:600">${r.name}</td>
      <td style="color:var(--text-muted)">${r.department || '--'}</td>
      <td style="background:#F7FAFF">
        ${r.part_number ? `<div style="font-weight:600">${r.part_number}</div>` : ''}
        ${r.estimate_no ? `<div style="font-size:0.72rem;color:var(--text-muted)">見積:${r.estimate_no}</div>` : ''}
        ${!r.part_number && !r.estimate_no ? '--' : ''}
      </td>
      <td style="background:#F7FAFF;font-size:0.78rem">${codeLabel(r.work_code)}</td>
      <td style="background:#F7FAFF;white-space:nowrap">${r.board_start ? r.board_start.slice(0,5)+'〜'+(r.board_end||'').slice(0,5) : '--'}</td>
      <td style="background:#F0FDF4;font-size:0.78rem">${codeLabel(r.other_code)}</td>
      <td style="background:#F0FDF4;white-space:nowrap">${r.other_start ? r.other_start.slice(0,5)+'〜'+(r.other_end||'').slice(0,5) : '--'}</td>
    `;
    tbody.appendChild(tr);
  });
  tfoot.innerHTML = `<tr style="font-weight:700;background:#F8FAFC">
    <td colspan="5" style="text-align:right;padding:8px 12px">合計時間</td>
    <td style="background:#EFF6FF;padding:8px 12px">${fmtAdmMin(totalBoard)}</td>
    <td></td>
    <td style="background:#ECFDF5;padding:8px 12px">${fmtAdmMin(totalOther)}</td>
  </tr>`;
}

function calcRepMin(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
}

function fmtAdmMin(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + 'h' + (m ? m + 'm' : '');
}

function exportReportCSV() {
  if (!allAdminReports.length) { alert('データがありません'); return; }
  const codeLabel = code => {
    if (!code) return '';
    const e = ADM_WORK_CODES.find(([c]) => c === code);
    return e ? `${e[0]}: ${e[1]}` : code;
  };
  const headers = ['日付','氏名','部署','品番','見積No','基板作業内容','基板開始','基板終了','その他作業内容','その他開始','その他終了'];
  const rows = allAdminReports.map(r => [
    r.report_date, r.name, r.department || '',
    r.part_number || '', r.estimate_no || '',
    codeLabel(r.work_code),
    r.board_start ? r.board_start.slice(0,5) : '', r.board_end ? r.board_end.slice(0,5) : '',
    codeLabel(r.other_code),
    r.other_start ? r.other_start.slice(0,5) : '', r.other_end ? r.other_end.slice(0,5) : '',
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `日報_${document.getElementById('rep-adm-year').value}_${document.getElementById('rep-adm-month').value}.csv`;
  a.click();
}

// ── 営業報告（管理者） ──
let allAdminSales = [];

async function initAdminSales() {
  const ysel = document.getElementById('sale-adm-year');
  if (!ysel.options.length) {
    const now = new Date();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      if (y === now.getFullYear()) o.selected = true;
      ysel.appendChild(o);
    }
    const msel = document.getElementById('sale-adm-month');
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m + '月';
      if (m === now.getMonth() + 1) o.selected = true;
      msel.appendChild(o);
    }
  }
  await loadDeptOptions('sale-adm-dept', true);
  await loadSaleEmpOptions();
  loadAdminSales();
}

async function loadSaleEmpOptions() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    const sel = document.getElementById('sale-adm-emp');
    sel.innerHTML = '<option value="">全員</option>';
    (d.employees || []).forEach(e => {
      const o = document.createElement('option');
      o.value = e.employee_id;
      o.textContent = `${e.name}（${e.department || '--'}）`;
      sel.appendChild(o);
    });
  } catch(e) {}
}

async function loadAdminSales() {
  const year = document.getElementById('sale-adm-year').value;
  const month = document.getElementById('sale-adm-month').value;
  const dept = document.getElementById('sale-adm-dept').value;
  const emp = document.getElementById('sale-adm-emp').value;
  try {
    let url = `/api/admin/sales?year=${year}&month=${month}`;
    if (dept) url += `&department_id=${dept}`;
    if (emp) url += `&employee_id=${emp}`;
    const res = await api(url);
    const d = await res.json();
    allAdminSales = d.entries || [];
    renderAdminSales();
  } catch(e) {}
}

function renderAdminSales() {
  const tbody = document.getElementById('sale-adm-body');
  tbody.innerHTML = '';
  if (!allAdminSales.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px">データなし</td></tr>';
    return;
  }
  const statusColor = { '商談中':'#3B82F6','提案済':'#8B5CF6','受注':'#10B981','失注':'#EF4444','保留':'#F59E0B' };
  allAdminSales.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${r.report_date}</td>
      <td style="font-weight:600">${r.name}</td>
      <td style="color:var(--text-muted)">${r.department || '--'}</td>
      <td style="font-weight:600">${r.client_company}</td>
      <td style="font-size:0.78rem">${[r.client_dept, r.client_name].filter(Boolean).join(' / ') || '--'}</td>
      <td style="font-size:0.78rem">${r.purpose || '--'}</td>
      <td style="font-size:0.78rem;max-width:200px;white-space:pre-wrap;word-break:break-word">${r.content || '--'}</td>
      <td style="text-align:right">${r.amount != null ? Number(r.amount).toLocaleString() + '円' : '--'}</td>
      <td><span style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:12px;background:${(statusColor[r.status]||'#94A3B8')}22;color:${statusColor[r.status]||'#94A3B8'}">${r.status||'--'}</span></td>
      <td style="font-size:0.78rem">${r.next_action || '--'}</td>
      <td style="white-space:nowrap">${r.next_date || '--'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function exportSalesCSV() {
  if (!allAdminSales.length) { alert('データがありません'); return; }
  const headers = ['日付','氏名','部署','会社名','担当部署','担当者名','訪問目的','内容','金額','ステータス','次回アクション','次回予定日'];
  const rows = allAdminSales.map(r => [
    r.report_date, r.name, r.department || '',
    r.client_company, r.client_dept || '', r.client_name || '',
    r.purpose || '', r.content || '',
    r.amount != null ? r.amount : '',
    r.status || '', r.next_action || '', r.next_date || '',
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `営業報告_${document.getElementById('sale-adm-year').value}_${document.getElementById('sale-adm-month').value}.csv`;
  a.click();
}

// ── 残業申請管理（管理者） ──
let allAdminOvertime = [];
let overtimeFilter = 'pending';

async function initAdminOvertime() {
  const ysel = document.getElementById('ot-adm-year');
  if (!ysel.options.length) {
    const now = new Date();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '年';
      if (y === now.getFullYear()) o.selected = true;
      ysel.appendChild(o);
    }
    const msel = document.getElementById('ot-adm-month');
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m + '月';
      if (m === now.getMonth() + 1) o.selected = true;
      msel.appendChild(o);
    }
  }
  await loadDeptOptions('ot-adm-dept', true);
  loadAdminOvertime();
}

function filterAdminOvertime(f) {
  overtimeFilter = f;
  document.getElementById('otf-pending').style.fontWeight = f === 'pending' ? '800' : '';
  document.getElementById('otf-all').style.fontWeight = f === 'all' ? '800' : '';
  loadAdminOvertime();
}

async function loadAdminOvertime() {
  const year = document.getElementById('ot-adm-year').value;
  const month = document.getElementById('ot-adm-month').value;
  const dept = document.getElementById('ot-adm-dept').value;
  try {
    let url = `/api/admin/overtime?year=${year}&month=${month}`;
    if (overtimeFilter !== 'all') url += `&status=${overtimeFilter}`;
    if (dept) url += `&department_id=${dept}`;
    const res = await api(url);
    const d = await res.json();
    allAdminOvertime = d.entries || [];
    renderAdminOvertime();
  } catch(e) {}
}

function renderAdminOvertime() {
  const tbody = document.getElementById('ot-adm-body');
  if (!allAdminOvertime.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:20px">データなし</td></tr>';
    return;
  }
  const sc = { pending:'#F59E0B', approved:'#10B981', rejected:'#EF4444' };
  const sl = { pending:'申請中', approved:'承認済', rejected:'却下' };
  tbody.innerHTML = '';
  allAdminOvertime.forEach(r => {
    const otMin = r.overtime_minutes || 0;
    const otStr = otMin ? `${Math.floor(otMin/60)}h${otMin%60?otMin%60+'m':''}` : '--';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${r.work_date}</td>
      <td style="font-weight:600">${r.name}</td>
      <td style="color:var(--text-muted)">${r.department||'--'}</td>
      <td style="text-align:center">${r.planned_end ? r.planned_end.slice(0,5) : '--'}</td>
      <td style="text-align:center">${r.clock_out ? r.clock_out.slice(0,5) : '--'}</td>
      <td style="text-align:center;color:var(--warning);font-weight:700">${otStr}</td>
      <td style="font-size:0.78rem;max-width:160px">${r.reason||'--'}</td>
      <td><span style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:12px;background:${sc[r.status]||'#94A3B8'}22;color:${sc[r.status]||'#94A3B8'}">${sl[r.status]||r.status}</span></td>
      <td style="white-space:nowrap">
        ${r.status === 'pending' && isSuperAdmin ? `
          <button class="btn-outline btn-sm" style="color:var(--accent);border-color:var(--accent)" onclick="approveOvertime(${r.id})">承認</button>
          <button class="btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger);margin-left:4px" onclick="rejectOvertime(${r.id})">却下</button>
        ` : ''}
        ${r.status === 'pending' && isManager ? `
          <button class="btn-outline btn-sm" style="color:var(--text-muted)" onclick="deleteOvertimeAdmin(${r.id})">取消</button>
        ` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function approveOvertime(id) {
  if (!confirm('この残業申請を承認しますか？')) return;
  try {
    const res = await api(`/api/admin/overtime/${id}/approve`, 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail||'エラー'); return; }
    loadAdminOvertime();
  } catch(e) { alert('通信エラー'); }
}

async function rejectOvertime(id) {
  if (!confirm('この残業申請を却下しますか？')) return;
  try {
    const res = await api(`/api/admin/overtime/${id}/reject`, 'POST');
    if (!res.ok) { const d = await res.json(); alert(d.detail||'エラー'); return; }
    loadAdminOvertime();
  } catch(e) { alert('通信エラー'); }
}

async function openOvertimeSubmitModal() {
  try {
    const res = await api('/api/admin/employees');
    const d = await res.json();
    const list = document.getElementById('ot-emp-list');
    list.innerHTML = '';
    (d.employees || []).forEach(e => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:0.88rem';
      label.innerHTML = `<input type="checkbox" class="ot-emp-cb" value="${e.employee_id}" onchange="updateOtEmpCount()" style="width:16px;height:16px;cursor:pointer">
        <span style="font-weight:600">${e.name}</span><span style="color:var(--text-muted);font-size:0.78rem">${e.department||''}</span>`;
      list.appendChild(label);
    });
    updateOtEmpCount();
  } catch(e) {}
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('ot-sub-date').value = today;
  document.getElementById('ot-sub-end').value = '';
  document.getElementById('ot-sub-reason').value = '';
  document.getElementById('overtime-submit-modal').classList.remove('hidden');
}

function otCheckAll(checked) {
  document.querySelectorAll('.ot-emp-cb').forEach(cb => cb.checked = checked);
  updateOtEmpCount();
}

function updateOtEmpCount() {
  const n = document.querySelectorAll('.ot-emp-cb:checked').length;
  document.getElementById('ot-emp-count').textContent = n ? `${n}名選択中` : '';
}

function closeOvertimeSubmitModal() {
  document.getElementById('overtime-submit-modal').classList.add('hidden');
}

async function submitOvertime() {
  const checked = [...document.querySelectorAll('.ot-emp-cb:checked')].map(cb => cb.value);
  const date = document.getElementById('ot-sub-date').value;
  if (!checked.length) { alert('従業員を1名以上選択してください'); return; }
  if (!date) { alert('日付を入力してください'); return; }
  const plannedEnd = document.getElementById('ot-sub-end').value || null;
  const reason = document.getElementById('ot-sub-reason').value.trim() || null;

  const errors = [];
  for (const empId of checked) {
    try {
      const res = await api('/api/overtime', 'POST', { employee_id: empId, work_date: date, planned_end: plannedEnd, reason });
      if (!res.ok) {
        const d = await res.json();
        errors.push(d.detail || 'エラー');
      }
    } catch(e) { errors.push('通信エラー'); }
  }

  closeOvertimeSubmitModal();
  loadAdminOvertime();
  if (errors.length) {
    alert(`${checked.length - errors.length}件申請完了。${errors.length}件エラー:\n` + errors.join('\n'));
  } else {
    alert(`${checked.length}名分の残業申請を送信しました`);
  }
}

async function deleteOvertimeAdmin(id) {
  if (!confirm('この申請を取り消しますか？')) return;
  try {
    const res = await api(`/api/overtime/${id}`, 'DELETE');
    if (!res.ok) { const d = await res.json(); alert(d.detail||'エラー'); return; }
    loadAdminOvertime();
  } catch(e) { alert('通信エラー'); }
}

// 初期ロード
loadDashboard();
loadDeptOptions('att-dept', true);
