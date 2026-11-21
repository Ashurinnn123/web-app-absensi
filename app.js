// =========================================================================
// KONFIGURASI WEB APP GOOGLE APPS SCRIPT
// =========================================================================
const URL_GAS = "https://script.google.com/macros/s/AKfycbxKxGdU51AkpR1gplRrDr4izzOysf-0rfSLGQErqELV_g4cuZIwQYQgYKWJil7JqziufQ/exec";
const STORAGE_KEY_PENDING = "web_absensi_pending_submission_v1";
const KEY_HISTORY_ABSENSI = "web_absensi_history_harian_v1";

let currentPin = "";
let masterPekerja = []; // Data master semua pekerja aktif dari server
let fotoBase64Terkompresi = "";
let activeSubmissionId = null; // UUID pengiriman saat ini
let gpsGagalSekali = false; // Flag toleransi pengiriman tanpa GPS jika GPS gagal
let proyekAktifSebelumnya = ""; // Menyimpan nama proyek yang aktif sebelumnya
let draftsPerProyek = {}; // Menyimpan draft isian { status_hadir, jam_lembur, catatan } per proyek

// Helper Tanggal YYYY-MM-DD
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Ambil riwayat absensi pekerja yang sudah berhasil terkirim hari ini dari local storage
function getRiwayatAbsensiHariIni() {
  try {
    const raw = localStorage.getItem(KEY_HISTORY_ABSENSI);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const today = getTodayString();
    return parsed[today] || {};
  } catch (e) {
    return {};
  }
}

// Simpan riwayat absensi pekerja yang baru saja berhasil terkirim hari ini
function simpanRiwayatAbsensiHariIni(namaProyek, daftarPekerjaTersimpan) {
  try {
    const today = getTodayString();
    let allHistory = {};
    try {
      allHistory = JSON.parse(localStorage.getItem(KEY_HISTORY_ABSENSI) || "{}");
    } catch (e) { }
    if (!allHistory[today]) allHistory[today] = {};

    const jamSekarang = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    daftarPekerjaTersimpan.forEach(p => {
      allHistory[today][p.id_pekerja] = {
        proyek: namaProyek,
        status_hadir: p.status_hadir,
        jam_lembur: p.jam_lembur,
        catatan: p.catatan || "",
        jam: p.jam_terkirim || jamSekarang
      };
    });

    localStorage.setItem(KEY_HISTORY_ABSENSI, JSON.stringify(allHistory));
  } catch (e) {
    console.warn("Gagal menyimpan riwayat absensi harian:", e);
  }
}

// Sinkronkan data absensi hari ini yang ditarik dari Google Sheets ke local storage
function sinkronkanRiwayatCloudKeLocal(serverAbsensi) {
  if (!serverAbsensi || typeof serverAbsensi !== "object") return;
  try {
    const today = getTodayString();
    let allHistory = {};
    try {
      allHistory = JSON.parse(localStorage.getItem(KEY_HISTORY_ABSENSI) || "{}");
    } catch (e) { }
    if (!allHistory[today]) allHistory[today] = {};

    Object.keys(serverAbsensi).forEach(id => {
      const s = serverAbsensi[id];
      allHistory[today][id] = {
        proyek: s.nama_proyek || "",
        status_hadir: s.status_hadir,
        jam_lembur: s.jam_lembur || 0,
        catatan: s.catatan || "",
        jam: s.jam || "Tercatat"
      };
    });

    localStorage.setItem(KEY_HISTORY_ABSENSI, JSON.stringify(allHistory));
  } catch (e) {
    console.warn("Gagal sinkron riwayat cloud ke local:", e);
  }
}

// Simpan isian pekerja yang sedang dikerjakan ke dalam draft per-proyek
function simpanDraftProyek(namaProyek) {
  const pName = (namaProyek || "").trim();
  if (!pName || pName === "__TAMBAH_BARU__") return;
  if (!draftsPerProyek[pName]) draftsPerProyek[pName] = {};

  masterPekerja.forEach(p => {
    draftsPerProyek[pName][p.id_pekerja] = {
      status_hadir: p.status_hadir,
      jam_lembur: p.jam_lembur,
      catatan: p.catatan,
      sudah_terkirim: p.sudah_terkirim,
      proyek_terkirim: p.proyek_terkirim,
      jam_terkirim: p.jam_terkirim
    };
  });
}

// Pulihkan isian pekerja saat berpindah kembali ke proyek yang pernah dibuka
function pulihkanDraftProyek(proyekTarget) {
  const pName = (proyekTarget || "").trim();
  if (!pName || pName === "__TAMBAH_BARU__") return;
  const draft = draftsPerProyek[pName];
  if (!draft) return;

  masterPekerja.forEach(p => {
    if (draft[p.id_pekerja]) {
      const d = draft[p.id_pekerja];
      p.status_hadir = d.status_hadir;
      p.jam_lembur = d.jam_lembur;
      p.catatan = d.catatan;
      if (d.sudah_terkirim) {
        p.sudah_terkirim = true;
        p.proyek_terkirim = d.proyek_terkirim;
        p.jam_terkirim = d.jam_terkirim;
      }
    }
  });
}

// Helper Escape HTML untuk cegah Stored XSS
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Generate UUID v4 untuk submission_id
function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Inisialisasi tampilan tanggal hari ini
const tanggalEl = document.getElementById("tanggalHariIni");
if (tanggalEl) {
  tanggalEl.textContent = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

function tampilkanAlert(pesan, tipe = "success") {
  const box = document.getElementById("alertBox");
  box.textContent = pesan;
  box.className = "alert " + (tipe === "success" ? "alert-success" : tipe === "warning" ? "alert-warning" : "alert-error");
  box.style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function sembunyikanAlert() {
  document.getElementById("alertBox").style.display = "none";
}

function onInputChanged() {
  // Reset toleransi GPS dan submission tertunda jika ada perubahan isian
  gpsGagalSekali = false;
  hapusPendingSubmission();
}

function onProyekChanged() {
  const sel = document.getElementById("selectProyek");
  const inputManual = document.getElementById("inputProyekManual");

  // 1. Simpan draft proyek sebelumnya sebelum berpindah
  if (proyekAktifSebelumnya) {
    simpanDraftProyek(proyekAktifSebelumnya);
  }

  // 2. Tampilkan atau sembunyikan input manual
  if (sel.value === "__TAMBAH_BARU__") {
    inputManual.style.display = "block";
    inputManual.value = "";
    inputManual.focus();
  } else {
    inputManual.style.display = "none";
    inputManual.value = "";
  }

  const proyekBaru = getNamaProyekAktif();
  proyekAktifSebelumnya = proyekBaru;

  // 3. Pulihkan draft jika proyek ini pernah dibuka/disubmit sebelumnya
  pulihkanDraftProyek(proyekBaru);

  onInputChanged();
  renderDaftarPekerja();
}

function onInputProyekManualChanged() {
  onInputChanged();
  const proyekBaru = getNamaProyekAktif();
  proyekAktifSebelumnya = proyekBaru;
  renderDaftarPekerja();
}

/** Ambil nama proyek aktual: dari input manual jika memilih 'Tambah Baru', 
 *  atau dari dropdown jika memilih proyek yang ada. */
function getNamaProyekAktif() {
  const sel = document.getElementById("selectProyek");
  if (sel.value === "__TAMBAH_BARU__") {
    return document.getElementById("inputProyekManual").value.trim();
  }
  return sel.value;
}

function hapusPendingSubmission() {
  activeSubmissionId = null;
  try {
    localStorage.removeItem(STORAGE_KEY_PENDING);
  } catch (e) {
    console.warn("Gagal menghapus localStorage:", e);
  }
}

// 1. VERIFIKASI PIN & TARIK DATA PEKERJA (GET)
async function verifikasiPin() {
  sembunyikanAlert();
  const pin = document.getElementById("inputPin").value.trim();
  if (!pin) return tampilkanAlert("Silakan masukkan PIN Proyek terlebih dahulu.", "error");

  const btn = document.getElementById("btnMasuk");
  btn.disabled = true;
  btn.textContent = "Memuat data...";

  try {
    const res = await fetch(`${URL_GAS}?pin=${encodeURIComponent(pin)}`);
    const data = await res.json();

    if (data.status !== "success") {
      tampilkanAlert(data.message || "PIN Proyek salah.", "error");
      return;
    }

    currentPin = pin;
    const serverAbsensi = data.absensi_hari_ini || {};
    const localRiwayat = getRiwayatAbsensiHariIni();

    // Sinkronkan riwayat cloud Google Sheet ke local storage
    sinkronkanRiwayatCloudKeLocal(serverAbsensi);

    // Inisialisasi daftar pekerja; gabungkan server & lokal agar status kehadiran otomatis terisi
    masterPekerja = (data.daftar_pekerja || []).map(p => {
      const srv = serverAbsensi[p.id_pekerja];
      const loc = localRiwayat[p.id_pekerja];
      const sdh = srv || loc;

      const statusHadir = (sdh && sdh.status_hadir !== undefined && sdh.status_hadir !== null)
        ? Number(sdh.status_hadir)
        : null;

      return {
        id_pekerja: p.id_pekerja,
        nama_pekerja: p.nama_pekerja,
        keahlian: p.keahlian,
        proyek_default: p.proyek_default || "",
        status_hadir: statusHadir,
        jam_lembur: sdh ? Number(sdh.jam_lembur || 0) : 0,
        catatan: sdh ? (sdh.catatan || "") : "",
        sudah_terkirim: !!sdh,
        proyek_terkirim: sdh ? (sdh.nama_proyek || sdh.proyek || "") : "",
        jam_terkirim: sdh ? (sdh.jam || "Tercatat di server") : ""
      };
    });

    // Inisialisasi draft untuk setiap proyek yang sudah tercatat
    masterPekerja.forEach(p => {
      if (p.sudah_terkirim && p.proyek_terkirim) {
        if (!draftsPerProyek[p.proyek_terkirim]) draftsPerProyek[p.proyek_terkirim] = {};
        draftsPerProyek[p.proyek_terkirim][p.id_pekerja] = {
          status_hadir: p.status_hadir,
          jam_lembur: p.jam_lembur,
          catatan: p.catatan,
          sudah_terkirim: true,
          proyek_terkirim: p.proyek_terkirim,
          jam_terkirim: p.jam_terkirim
        };
      }
    });

    // Isi dropdown proyek
    const selectProyek = document.getElementById("selectProyek");
    selectProyek.innerHTML = "";
    const proyekList = (data.daftar_proyek && data.daftar_proyek.length) ? data.daftar_proyek : ["Proyek Utama"];
    proyekList.forEach(nama => {
      const opt = document.createElement("option");
      opt.value = nama;
      opt.textContent = nama;
      selectProyek.appendChild(opt);
    });

    // Tambahkan opsi input manual untuk proyek / lokasi baru
    const optManual = document.createElement("option");
    optManual.value = "__TAMBAH_BARU__";
    optManual.textContent = "➕ Ketik Nama Proyek / Lokasi Baru...";
    selectProyek.appendChild(optManual);

    proyekAktifSebelumnya = getNamaProyekAktif();
    pulihkanDraftProyek(proyekAktifSebelumnya);

    renderDaftarPekerja();
    document.getElementById("pinSection").classList.add("hidden");
    document.getElementById("mainSection").classList.remove("hidden");

    // Cek apakah ada submission tertunda akibat kegagalan jaringan sebelumnya
    cekPendingSubmission();

  } catch (err) {
    console.error("Detail error:", err);
    tampilkanAlert("Gagal terhubung ke server: " + (err.message || "Periksa sinyal internet lalu coba tekan Masuk lagi."), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Masuk";
  }
}

// Helper: Ambil pekerja yang relevan ditampilkan untuk proyek aktif
function getPekerjaDitampilkan() {
  const isManual = document.getElementById("selectProyek").value === "__TAMBAH_BARU__";
  const proyekTerpilih = (getNamaProyekAktif() || "").trim().toLowerCase();
  const tampilkanSemua = document.getElementById("checkPekerjaLain").checked;

  return masterPekerja.filter(p => {
    if (tampilkanSemua) return true; // Tampilkan seluruh pekerja jika dicentang mandor

    const def = (p.proyek_default || "").trim().toLowerCase();

    // Jika sudah ada nama proyek aktif (baik dipilih dari dropdown atau hasil ketikan manual)
    if (proyekTerpilih) {
      // Hanya tampilkan pekerja milik proyek ini, atau pekerja lepas (tanpa proyek default)
      return def === proyekTerpilih || !def;
    }

    // Jika opsi 'Tambah Baru' dipilih tetapi belum mengetik nama proyek baru
    if (isManual) {
      // JANGAN tampilkan pekerja proyek lain agar mandor tidak dipaksa mencentang pekerja proyek lain!
      // Hanya tampilkan pekerja lepas yang belum punya proyek default
      return !def;
    }

    return true;
  });
}

// 2. RENDER DAFTAR CEKLIS PEKERJA (DENGAN FILTER PROYEK & AUTO-FILL STATUS)
function renderDaftarPekerja() {
  const container = document.getElementById("workerList");
  const proyekTerpilih = getNamaProyekAktif();
  const pekerjaDitampilkan = getPekerjaDitampilkan();

  document.getElementById("jumlahPekerjaTampil").textContent = pekerjaDitampilkan.length;
  document.getElementById("jumlahPekerjaTotal").textContent = masterPekerja.length;
  container.innerHTML = "";

  // Banner indikator jika seluruh pekerja di proyek ini sudah tersimpan
  const semuaSudahTerkirim = pekerjaDitampilkan.length > 0 && pekerjaDitampilkan.every(p => p.sudah_terkirim);
  const bannerProyekStatus = document.getElementById("bannerProyekStatus");
  const btnKirim = document.getElementById("btnKirim");

  if (bannerProyekStatus) {
    if (semuaSudahTerkirim) {
      bannerProyekStatus.innerHTML = `
        <div style="background:#dcfce7; border:2px solid #86efac; border-radius:8px; padding:10px 14px; margin-bottom:12px; color:#15803d; font-size:14px; font-weight:700; display:flex; align-items:center; gap:8px;">
          <span style="font-size:18px;">✓</span> Seluruh pekerja di proyek "${esc(proyekTerpilih)}" sudah diabsen dan tersimpan hari ini.
        </div>
      `;
      bannerProyekStatus.style.display = "block";
      if (btnKirim) {
        btnKirim.textContent = "✓ Perbarui / Kirim Ulang Absensi";
        btnKirim.className = "btn-secondary";
      }
    } else {
      bannerProyekStatus.style.display = "none";
      bannerProyekStatus.innerHTML = "";
      if (btnKirim) {
        btnKirim.textContent = "Kirim Absensi Sekarang";
        btnKirim.className = "btn-success";
      }
    }
  }

  if (pekerjaDitampilkan.length === 0) {
    container.innerHTML = `
    <div style="padding: 16px; text-align: center; color: #4b5563; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;">
      Tidak ada pekerja yang terdaftar pada proyek "${esc(proyekTerpilih || "ini")}".<br>
      <span style="font-size: 14px;">Centang <b>"Tampilkan juga pekerja dari proyek lain"</b> atau tekan tombol <b>"+ Pekerja Baru"</b> untuk mendaftarkan pekerja ke proyek ini.</span>
    </div>
  `;
    return;
  }

  pekerjaDitampilkan.forEach(p => {
    // Cari index sebenarnya di masterPekerja
    const masterIdx = masterPekerja.findIndex(item => item.id_pekerja === p.id_pekerja);
    const isUnselected = p.status_hadir === null;
    const isAbsent = p.status_hadir === 0;

    const badgeSudahAbsen = p.sudah_terkirim
      ? `<div style="margin-top:3px;"><span style="background:#dcfce7; color:#15803d; border:1px solid #86efac; border-radius:4px; padding:2px 7px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:3px;">✓ Sudah Absen (${esc(p.proyek_terkirim || "Terkirim")}${p.jam_terkirim ? ` ${esc(p.jam_terkirim)}` : ""})</span></div>`
      : "";

    const div = document.createElement("div");
    div.className = "worker-item" + (isUnselected ? " unselected" : "");
    div.innerHTML = `
    <div class="worker-header">
      <div>
        <span class="worker-name">${esc(p.nama_pekerja)}</span>
        ${badgeSudahAbsen}
      </div>
      <div class="worker-badges">
        ${p.proyek_default && p.proyek_default.toLowerCase() !== proyekTerpilih.toLowerCase() ? `<span class="worker-proyek-tag">${esc(p.proyek_default)}</span>` : ""}
        <span class="worker-role">${esc(p.keahlian)}</span>
      </div>
    </div>
    <div class="status-group">
      <button type="button" class="status-btn ${p.status_hadir === 1 ? 'active-full' : ''}" onclick="setStatus(${masterIdx}, 1)">Full (1)</button>
      <button type="button" class="status-btn ${p.status_hadir === 0.5 ? 'active-half' : ''}" onclick="setStatus(${masterIdx}, 0.5)">1/2 Hari</button>
      <button type="button" class="status-btn ${p.status_hadir === 0 ? 'active-absent' : ''}" onclick="setStatus(${masterIdx}, 0)">Absen (0)</button>
    </div>
    <div class="extra-inputs">
      <input type="number" min="0" max="12" step="0.5" placeholder="Lembur (jam)" 
        value="${p.jam_lembur > 0 ? p.jam_lembur : ''}" 
        ${isAbsent ? 'disabled title="Pekerja absen tidak dapat lembur"' : ''} 
        oninput="ubahLembur(${masterIdx}, this.value)">
      <input type="text" placeholder="Catatan singkat (opsional)" 
        value="${esc(p.catatan)}" 
        oninput="ubahCatatan(${masterIdx}, this.value)">
    </div>
  `;
    container.appendChild(div);
  });
}

function setStatus(index, nilai) {
  onInputChanged();
  masterPekerja[index].status_hadir = nilai;
  // Jika status diubah jadi Absen (0), otomatis reset lembur ke 0
  if (nilai === 0) {
    masterPekerja[index].jam_lembur = 0;
  }
  simpanDraftProyek(getNamaProyekAktif());
  renderDaftarPekerja();
}

function ubahLembur(index, nilai) {
  onInputChanged();
  const angka = parseFloat(nilai);
  masterPekerja[index].jam_lembur = isNaN(angka) ? 0 : Math.max(0, Math.min(12, angka));
  simpanDraftProyek(getNamaProyekAktif());
}

function ubahCatatan(index, nilai) {
  onInputChanged();
  masterPekerja[index].catatan = nilai;
  simpanDraftProyek(getNamaProyekAktif());
}

// 3. KOMPRESI FOTO BERULANG SAMPAI <= 300 KB (< 307200 bytes)
async function prosesFoto(event) {
  const file = event.target.files[0];
  if (!file) return;

  onInputChanged();
  const info = document.getElementById("infoFoto");
  const preview = document.getElementById("previewFoto");
  info.style.color = "#1d4ed8";
  info.textContent = "Mengompresi foto...";

  try {
    fotoBase64Terkompresi = await kompresFotoIteratif(file, 300 * 1024);
    const byteSize = hitungUkuranBase64(fotoBase64Terkompresi);
    const kbSize = Math.round(byteSize / 1024);

    preview.src = fotoBase64Terkompresi;
    preview.style.display = "block";
    info.style.color = "#15803d";
    info.textContent = `Foto siap dikirim (${kbSize} KB &le; 300 KB).`;
  } catch (err) {
    fotoBase64Terkompresi = "";
    preview.style.display = "none";
    info.style.color = "#b91c1c";
    info.textContent = err.message || "Gagal mengompresi foto.";
    tampilkanAlert(err.message || "Ukuran foto terlalu besar dan gagal dikompres di bawah 300 KB.", "error");
  }
}

function hitungUkuranBase64(b64String) {
  const clean = b64String.includes(",") ? b64String.split(",")[1] : b64String;
  const padding = (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  return Math.floor((clean.length * 3) / 4) - padding;
}

function muatGambar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Gagal membaca file gambar."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Gagal membuka file."));
    reader.readAsDataURL(file);
  });
}

async function kompresFotoIteratif(file, targetMaxBytes) {
  const img = await muatGambar(file);
  let canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");

  let currentWidth = img.width;
  let currentHeight = img.height;
  const MAX_INITIAL_DIM = 1280;

  if (currentWidth > MAX_INITIAL_DIM || currentHeight > MAX_INITIAL_DIM) {
    if (currentWidth >= currentHeight) {
      currentHeight = Math.round((currentHeight * MAX_INITIAL_DIM) / currentWidth);
      currentWidth = MAX_INITIAL_DIM;
    } else {
      currentWidth = Math.round((currentWidth * MAX_INITIAL_DIM) / currentHeight);
      currentHeight = MAX_INITIAL_DIM;
    }
  }

  // Coba turunkan kualitas (0.8 -> 0.4)
  const daftarKualitas = [0.8, 0.7, 0.6, 0.5, 0.4];
  for (let loopDim = 0; loopDim < 4; loopDim++) {
    canvas.width = currentWidth;
    canvas.height = currentHeight;
    ctx.clearRect(0, 0, currentWidth, currentHeight);
    ctx.drawImage(img, 0, 0, currentWidth, currentHeight);

    for (let q of daftarKualitas) {
      const b64 = canvas.toDataURL("image/jpeg", q);
      if (hitungUkuranBase64(b64) <= targetMaxBytes) {
        return b64;
      }
    }

    // Jika masih lebih besar dari 300 KB, kecilkan resolusi 20% selama lebar >= 480px
    if (currentWidth > 480) {
      currentWidth = Math.round(currentWidth * 0.8);
      currentHeight = Math.round(currentHeight * 0.8);
    } else {
      break; // Sudah di batas minimum dimensi 480px
    }
  }

  // Upaya terakhir pada resolusi minimal dengan kompresi 0.35
  const finalB64 = canvas.toDataURL("image/jpeg", 0.35);
  if (hitungUkuranBase64(finalB64) <= targetMaxBytes) {
    return finalB64;
  }

  throw new Error("Foto tidak dapat dikompresi hingga < 300 KB. Mohon ambil foto kembali.");
}

// 4. AMBIL KOORDINAT GPS DENGAN TIMEOUT
function ambilKoordinatGPS() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve({ status: "gagal", koordinat: "-" });
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        resolve({ status: "ok", koordinat: `${lat}, ${lng}` });
      },
      () => resolve({ status: "gagal", koordinat: "-" }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );
  });
}

// 5. VALIDASI & PENGIRIMAN ABSENSI (POST)
async function kirimAbsensi() {
  sembunyikanAlert();
  const namaProyek = getNamaProyekAktif();
  const namaOperator = document.getElementById("inputOperator").value.trim();

  if (!namaProyek) {
    if (document.getElementById("selectProyek").value === "__TAMBAH_BARU__") {
      return tampilkanAlert("Silakan ketik nama proyek / lokasi baru terlebih dahulu.", "error");
    }
    return tampilkanAlert("Nama Proyek / Lokasi wajib dipilih atau diisi.", "error");
  }
  if (!namaOperator) {
    return tampilkanAlert("Nama Mandor / Operator wajib diisi.", "error");
  }
  if (!fotoBase64Terkompresi) {
    return tampilkanAlert("Silakan ambil foto kelompok pekerja terlebih dahulu sebelum mengirim.", "error");
  }

  // Ambil hanya pekerja yang ditargetkan untuk proyek yang sedang aktif
  const pekerjaTarget = getPekerjaDitampilkan();

  if (pekerjaTarget.length === 0) {
    return tampilkanAlert(`Tidak ada pekerja yang terdaftar pada proyek "${esc(namaProyek)}". Tambahkan pekerja baru atau centang "Tampilkan juga pekerja dari proyek lain".`, "error");
  }

  // Validasi 1: Hanya periksa pekerja yang sedang diabsen di proyek ini
  const pekerjaTanpaStatus = pekerjaTarget.filter(p => p.status_hadir === null);
  if (pekerjaTanpaStatus.length > 0) {
    return tampilkanAlert(
      `Terdapat ${pekerjaTanpaStatus.length} pekerja di proyek "${namaProyek}" yang belum ditentukan status kehadirannya. Mohon tentukan status (Full, 1/2 Hari, atau Absen).`,
      "error"
    );
  }

  // Validasi 2: Pekerja absen (0) tidak boleh memiliki jam lembur
  const salahLembur = pekerjaTarget.find(p => p.status_hadir === 0 && Number(p.jam_lembur) > 0);
  if (salahLembur) {
    return tampilkanAlert(
      `Pekerja "${salahLembur.nama_pekerja}" berstatus Absen (0) tetapi memiliki jam lembur (${salahLembur.jam_lembur} jam). Mohon perbaiki.`,
      "error"
    );
  }

  // Validasi 3: Jam lembur 0-12
  const batasLembur = pekerjaTarget.find(p => Number(p.jam_lembur) < 0 || Number(p.jam_lembur) > 12);
  if (batasLembur) {
    return tampilkanAlert(`Jam lembur pekerja "${batasLembur.nama_pekerja}" di luar batas wajar (0 - 12 jam).`, "error");
  }

  const btn = document.getElementById("btnKirim");
  btn.disabled = true;
  btn.textContent = "Mengecek lokasi GPS & mengirim...";

  try {
    const gpsResult = await ambilKoordinatGPS();

    // Penanganan GPS gagal: beri toleransi konfirmasi jika gagal pertama kali
    if (gpsResult.status === "gagal" && !gpsGagalSekali) {
      gpsGagalSekali = true;
      btn.disabled = false;
      btn.textContent = "Kirim Absensi Sekarang";
      return tampilkanAlert(
        "Lokasi GPS tidak berhasil diperoleh. Pastikan fitur Lokasi (GPS) HP Anda aktif dan beri izin browser. Tekan tombol 'Kirim Absensi Sekarang' sekali lagi jika ingin tetap mengirim tanpa lokasi GPS.",
        "warning"
      );
    }

    // Pastikan ada submission_id yang konsisten untuk deduplikasi
    if (!activeSubmissionId) {
      activeSubmissionId = generateUUID();
    }

    const payload = {
      pin: currentPin,
      action: "kirim_absensi",
      submission_id: activeSubmissionId,
      nama_proyek: namaProyek,
      nama_operator: namaOperator,
      koordinat_gps: gpsResult.koordinat,
      gps_status: gpsResult.status,
      foto_base64: fotoBase64Terkompresi,
      daftar_absensi: pekerjaTarget.map(p => ({
        id_pekerja: p.id_pekerja,
        nama_pekerja: p.nama_pekerja,
        keahlian: p.keahlian,
        status_hadir: p.status_hadir,
        jam_lembur: Number(p.jam_lembur || 0),
        catatan: p.catatan || ""
      }))
    };

    // Simpan backup payload di localStorage (tanpa PIN) untuk antisipasi putus jaringan
    simpanPendingSubmission(payload);

    const res = await fetch(URL_GAS, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    const hasil = await res.json();
    if (hasil.status === "success") {
      tampilkanAlert(hasil.message || "Data absensi berhasil disimpan ke Google Sheets.", "success");
      // Hapus pending submission karena sudah sukses diterima server
      hapusPendingSubmission();

      // Simpan riwayat absensi pekerja yang baru saja disubmit untuk hari ini
      simpanRiwayatAbsensiHariIni(namaProyek, pekerjaTarget);

      // Tandai pekerja di memory bahwa mereka sudah terkirim hari ini
      const jamSekarang = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
      pekerjaTarget.forEach(p => {
        p.sudah_terkirim = true;
        p.proyek_terkirim = namaProyek;
        p.jam_terkirim = jamSekarang;
      });

      // Simpan ke draft proyek agar saat berganti proyek dan kembali lagi, isian tetap utuh
      simpanDraftProyek(namaProyek);

      // Jika tadi menggunakan nama proyek manual baru, daftarkan ke dropdown opsi
      const selProyek = document.getElementById("selectProyek");
      if (selProyek.value === "__TAMBAH_BARU__" && namaProyek) {
        let optionExists = false;
        for (let i = 0; i < selProyek.options.length; i++) {
          if (selProyek.options[i].value.toLowerCase() === namaProyek.toLowerCase()) {
            optionExists = true;
            selProyek.value = selProyek.options[i].value;
            break;
          }
        }
        if (!optionExists) {
          const optBaru = document.createElement("option");
          optBaru.value = namaProyek;
          optBaru.textContent = namaProyek;
          selProyek.insertBefore(optBaru, selProyek.lastElementChild);
          selProyek.value = namaProyek;
        }
        document.getElementById("inputProyekManual").style.display = "none";
        document.getElementById("inputProyekManual").value = "";
        proyekAktifSebelumnya = namaProyek;
      }

      // Reset foto untuk proyek berikutnya
      fotoBase64Terkompresi = "";
      document.getElementById("previewFoto").style.display = "none";
      document.getElementById("infoFoto").textContent = "";
      document.getElementById("inputFoto").value = "";

      // Render ulang daftar pekerja
      renderDaftarPekerja();
    } else {
      // Jika server menjawab dengan error logis, jangan retry otomatis payload lama
      hapusPendingSubmission();
      tampilkanAlert(hasil.message || "Gagal menyimpan absensi.", "error");
    }

  } catch (err) {
    // Terjadi Network Error / Koneksi terputus total
    tampilkanAlert(
      "Koneksi terputus saat pengiriman. Data absensi Anda tersimpan aman di HP ini. Silakan periksa sinyal lalu tekan tombol 'Kirim Absensi Sekarang' kembali.",
      "warning"
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Kirim Absensi Sekarang";
  }
}

function simpanPendingSubmission(payload) {
  try {
    const dataBackup = {
      submission_id: payload.submission_id,
      nama_proyek: payload.nama_proyek,
      nama_operator: payload.nama_operator,
      saved_at: Date.now()
    };
    localStorage.setItem(STORAGE_KEY_PENDING, JSON.stringify(dataBackup));
  } catch (e) {
    console.warn("Gagal menyimpan ke localStorage:", e);
  }
}

function cekPendingSubmission() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PENDING);
    if (raw) {
      const pending = JSON.parse(raw);
      if (pending && pending.submission_id) {
        activeSubmissionId = pending.submission_id;
        tampilkanAlert("Ditemukan data pengiriman sebelumnya yang belum terkonfirmasi. Tekan Kirim untuk melanjutkan pengiriman.", "warning");
      }
    }
  } catch (e) { }
}

// 6. TAMBAH PEKERJA BARU DI TEMPAT
function bukaModalTambah() {
  sembunyikanModalAlert();
  document.getElementById("baruNama").value = "";
  const sel = document.getElementById("selectProyek");
  const inputManual = document.getElementById("inputProyekManual");

  if (sel.value === "__TAMBAH_BARU__" && !inputManual.value.trim()) {
    tampilkanAlert("Silakan ketik nama proyek / lokasi baru terlebih dahulu pada kotak isian sebelum menambah pekerja.", "warning");
    inputManual.focus();
    return;
  }

  const proyekAktif = getNamaProyekAktif() || "Proyek Utama";
  const infoEl = document.getElementById("modalProyekInfo");
  if (infoEl) {
    infoEl.textContent = "📍 Lokasi / Proyek: " + proyekAktif;
  }
  document.getElementById("modalTambah").style.display = "flex";
  document.getElementById("baruNama").focus();
}

function tutupModalTambah() {
  document.getElementById("modalTambah").style.display = "none";
}

function tampilkanModalAlert(pesan) {
  const el = document.getElementById("modalAlert");
  el.textContent = pesan;
  el.style.display = "block";
}

function sembunyikanModalAlert() {
  document.getElementById("modalAlert").style.display = "none";
}

async function simpanPekerjaBaru() {
  sembunyikanModalAlert();
  const nama = document.getElementById("baruNama").value.trim();
  const keahlian = document.getElementById("baruKeahlian").value;
  const proyek = getNamaProyekAktif() || "Proyek Utama";

  if (!nama) {
    return tampilkanModalAlert("Nama pekerja wajib diisi.");
  }

  // Cek duplikasi nama di client
  const sudahAda = masterPekerja.some(p => p.nama_pekerja.toLowerCase() === nama.toLowerCase());
  if (sudahAda) {
    return tampilkanModalAlert(`Pekerja dengan nama "${nama}" sudah terdaftar.`);
  }

  const btn = document.getElementById("btnSimpanPekerja");
  btn.disabled = true;
  btn.textContent = "Menyimpan...";

  try {
    const res = await fetch(URL_GAS, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        pin: currentPin,
        action: "tambah_pekerja",
        nama_pekerja: nama,
        keahlian: keahlian,
        proyek_default: proyek
      })
    });

    const hasil = await res.json();
    if (hasil.status === "success") {
      const proyekDisimpan = hasil.pekerja.proyek_default || proyek;
      const pekerjaBaru = {
        id_pekerja: hasil.pekerja.id_pekerja,
        nama_pekerja: hasil.pekerja.nama_pekerja,
        keahlian: hasil.pekerja.keahlian,
        proyek_default: proyekDisimpan,
        status_hadir: null, // Baru ditambahkan, mandor wajib tentukan statusnya
        jam_lembur: 0,
        catatan: "",
        sudah_terkirim: false,
        proyek_terkirim: "",
        jam_terkirim: ""
      };
      masterPekerja.push(pekerjaBaru);

      // Jika sebelumnya memilih proyek manual baru, daftarkan ke dropdown dan aktifkan
      const selProyek = document.getElementById("selectProyek");
      if (proyekDisimpan) {
        let optionExists = false;
        for (let i = 0; i < selProyek.options.length; i++) {
          if (selProyek.options[i].value.toLowerCase() === proyekDisimpan.toLowerCase()) {
            optionExists = true;
            selProyek.value = selProyek.options[i].value;
            break;
          }
        }
        if (!optionExists) {
          const optBaru = document.createElement("option");
          optBaru.value = proyekDisimpan;
          optBaru.textContent = proyekDisimpan;
          selProyek.insertBefore(optBaru, selProyek.lastElementChild);
          selProyek.value = proyekDisimpan;
        }
        document.getElementById("inputProyekManual").style.display = "none";
        document.getElementById("inputProyekManual").value = "";
        proyekAktifSebelumnya = proyekDisimpan;
      }

      simpanDraftProyek(proyekDisimpan);
      renderDaftarPekerja();
      tutupModalTambah();
      tampilkanAlert(`Pekerja baru "${nama}" (${hasil.pekerja.id_pekerja}) berhasil didaftarkan untuk proyek "${proyekDisimpan}". Silakan tentukan status kehadirannya.`, "success");
    } else {
      tampilkanModalAlert(hasil.message || "Gagal menambah pekerja baru.");
    }
  } catch (err) {
    console.error("Detail error tambah pekerja:", err);
    tampilkanModalAlert("Gagal terhubung ke server: " + (err.message || "Periksa sinyal internet lalu coba lagi."));
  } finally {
    btn.disabled = false;
    btn.textContent = "Simpan";
  }
}
