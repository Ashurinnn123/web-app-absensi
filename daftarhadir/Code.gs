// =========================================================================
// MIDDLEWARE GOOGLE APPS SCRIPT: SISTEM ABSENSI PEKERJA LAPANGAN
// =========================================================================

/**
 * KONFIGURASI UTAMA
 * Nilai default dapat ditimpa melalui Project Settings > Script Properties di Google Apps Script.
 */
const CONFIG = {
  DEFAULT_PIN: "1234", // PIN fallback jika belum diatur di Script Properties
  FOLDER_FOTO_ID: "GANTI_DENGAN_ID_FOLDER_GOOGLE_DRIVE", // ID folder Google Drive untuk foto absensi
  SHEET_MASTER: "Master_Pekerja",
  SHEET_LOG: "Log_Absensi",
  TIMEZONE: "Asia/Jakarta",
  SHARE_FOTO_PUBLIC: false // Set true jika foto harus bisa diakses publik (tanpa login Google)
};

/**
 * STRUKTUR ROW & COLUMN TEMPLATE SPREADSHEET
 * Sesuai template: baris 1-2 adalah judul, baris 4 adalah header, data mulai baris 5.
 */
const MASTER_CONFIG = {
  HEADER_ROW: 4,      // Baris header
  DATA_START_ROW: 5,  // Baris pertama data pekerja
  TOTAL_COLUMNS: 7,   // Kolom A sampai G
  COL_ID: 0,          // Kolom A: ID_Pekerja
  COL_NAMA: 1,        // Kolom B: Nama_Pekerja
  COL_KEAHLIAN: 2,    // Kolom C: Keahlian
  COL_PROYEK: 3,      // Kolom D: Proyek_Default
  COL_STATUS: 4,      // Kolom E: Status (Aktif / Nonaktif)
  COL_UPAH: 5,        // Kolom F: Upah_Harian
  COL_LEMBUR: 6,      // Kolom G: Tarif_Lembur_Per_Jam
  // Lebar kolom A-G dalam pixel (sesuaikan dengan selera tampilanmu)
  COLUMN_WIDTHS: [110, 180, 150, 160, 110, 140, 160],
  ROW_HEIGHT: 28      // Tinggi baris data dalam pixel
};

const LOG_CONFIG = {
  HEADER_ROW: 4,
  DATA_START_ROW: 5,
  TOTAL_COLUMNS: 14   // Kolom A sampai N (termasuk Submission_ID dan GPS_Status)
};

/**
 * Konfigurasi tab Rekap_Upah
 * DATA_START_ROW: baris pertama tempat data pekerja berada (di bawah semua header/judul)
 */
const REKAP_CONFIG = {
  DATA_START_ROW: 11,  // Baris pertama data pekerja di Rekap_Upah (default: baris 11)
  SHEET_NAME: "Rekap_Upah",
  GRAND_TOTAL_TEXT: "GRAND TOTAL"
};

// =========================================================================
// 1. ENDPOINT GET (PENGAMBILAN DAFTAR PEKERJA & PROYEK)
// Dipanggil oleh Front-End saat memverifikasi PIN
// =========================================================================
function doGet(e) {
  try {
    const pin = (e && e.parameter && e.parameter.pin) ? String(e.parameter.pin).trim() : "";

    // Verifikasi PIN dengan proteksi brute-force
    const pinCheck = verifikasiAksesPin(pin);
    if (!pinCheck.valid) {
      return createJsonResponse({
        status: "error",
        message: pinCheck.message
      });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetMaster = ss.getSheetByName(CONFIG.SHEET_MASTER);
    if (!sheetMaster) {
      return createJsonResponse({
        status: "error",
        message: `Tab sheet '${CONFIG.SHEET_MASTER}' tidak ditemukan di spreadsheet ini.`
      });
    }

    const data = sheetMaster.getDataRange().getValues();
    const pekerjaAktif = [];
    const daftarProyekSet = new Set();

    // Baca data mulai dari DATA_START_ROW (indeks array 4 = baris ke-5 pada spreadsheet)
    const startIndex = MASTER_CONFIG.DATA_START_ROW - 1;
    for (let i = startIndex; i < data.length; i++) {
      const row = data[i];
      const idPekerja = String(row[MASTER_CONFIG.COL_ID] || "").trim();
      const nama = String(row[MASTER_CONFIG.COL_NAMA] || "").trim();
      const keahlian = String(row[MASTER_CONFIG.COL_KEAHLIAN] || "").trim();
      const proyekDefault = String(row[MASTER_CONFIG.COL_PROYEK] || "").trim();
      const status = String(row[MASTER_CONFIG.COL_STATUS] || "").trim().toLowerCase();

      // Hindari membaca baris kosong atau baris header
      if (!idPekerja || idPekerja.toUpperCase() === "ID_PEKERJA") continue;

      if (proyekDefault && proyekDefault.toUpperCase() !== "PROYEK_DEFAULT") {
        daftarProyekSet.add(proyekDefault);
      }

      // Hanya kirim pekerja berstatus Aktif ke perangkat mandor
      if (status === "aktif") {
        pekerjaAktif.push({
          id_pekerja: idPekerja,
          nama_pekerja: nama,
          keahlian: keahlian,
          proyek_default: proyekDefault
        });
      }
    }

    // Ambil data absensi yang sudah tercatat hari ini di Log_Absensi agar status kehadiran langsung tersinkron
    const sheetLog = ss.getSheetByName(CONFIG.SHEET_LOG);
    const absensiHariIniMap = {};
    if (sheetLog && sheetLog.getLastRow() >= LOG_CONFIG.DATA_START_ROW) {
      const todayStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd");
      const logData = sheetLog.getDataRange().getValues();
      const logStart = LOG_CONFIG.DATA_START_ROW - 1;

      for (let j = logStart; j < logData.length; j++) {
        const row = logData[j];
        const tglVal = row[1]; // Kolom B: Tanggal
        let tglRowStr = "";
        if (tglVal instanceof Date) {
          tglRowStr = Utilities.formatDate(tglVal, CONFIG.TIMEZONE, "yyyy-MM-dd");
        } else if (tglVal) {
          tglRowStr = String(tglVal).substring(0, 10);
        }

        if (tglRowStr === todayStr) {
          const proyekRow = String(row[2] || "").trim();
          const idPekerjaRow = String(row[4] || "").trim();
          const statusHadirRow = Number(row[7]);
          const jamLemburRow = Number(row[8] || 0);
          const catatanRow = String(row[11] || "").trim();
          let jamWib = "";
          const ts = row[0]; // Kolom A: Timestamp
          if (ts instanceof Date) {
            jamWib = Utilities.formatDate(ts, CONFIG.TIMEZONE, "HH:mm");
          }

          if (proyekRow) {
            daftarProyekSet.add(proyekRow);
          }
          if (idPekerjaRow) {
            absensiHariIniMap[idPekerjaRow] = {
              id_pekerja: idPekerjaRow,
              nama_proyek: proyekRow,
              status_hadir: statusHadirRow,
              jam_lembur: jamLemburRow,
              catatan: catatanRow,
              jam: jamWib
            };
          }
        }
      }
    }

    return createJsonResponse({
      status: "success",
      daftar_proyek: Array.from(daftarProyekSet),
      daftar_pekerja: pekerjaAktif,
      absensi_hari_ini: absensiHariIniMap
    });

  } catch (err) {
    return createJsonResponse({
      status: "error",
      message: "Gagal memuat data pekerja: " + err.message
    });
  }
}

// =========================================================================
// 2. ENDPOINT POST (MENERIMA DATA ABSENSI & TAMBAH PEKERJA)
// =========================================================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Kunci antrean eksekusi maksimal 20 detik agar penulisan baris tidak saling bertumpuk
    lock.waitLock(20000);

    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({
        status: "error",
        message: "Payload pengiriman kosong."
      });
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return createJsonResponse({
        status: "error",
        message: "Format JSON payload tidak valid."
      });
    }

    // Verifikasi PIN
    const pinCheck = verifikasiAksesPin(payload.pin);
    if (!pinCheck.valid) {
      return createJsonResponse({
        status: "error",
        message: pinCheck.message
      });
    }

    // Routing berdasarkan aksi yang diminta
    if (payload.action === "tambah_pekerja") {
      return handleTambahPekerja(payload);
    } else if (payload.action === "kirim_absensi") {
      return handleKirimAbsensi(payload);
    } else {
      return createJsonResponse({
        status: "error",
        message: "Aksi tidak dikenali: " + (payload.action || "-")
      });
    }

  } catch (err) {
    return createJsonResponse({
      status: "error",
      message: "Terjadi gangguan pada server: " + err.message
    });
  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// 3. FUNGSI TAMBAH PEKERJA BARU (KE TAB Master_Pekerja)
// =========================================================================
function handleTambahPekerja(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetMaster = ss.getSheetByName(CONFIG.SHEET_MASTER);
  if (!sheetMaster) {
    return createJsonResponse({ status: "error", message: `Tab '${CONFIG.SHEET_MASTER}' tidak ditemukan.` });
  }

  const nama = String(payload.nama_pekerja || "").trim();
  const keahlian = String(payload.keahlian || "").trim();
  const proyekDefault = String(payload.proyek_default || "").trim();

  if (!nama) {
    return createJsonResponse({ status: "error", message: "Nama pekerja wajib diisi." });
  }
  if (!keahlian) {
    return createJsonResponse({ status: "error", message: "Keahlian pekerja wajib dipilih." });
  }

  // Tentukan ID pekerja berikutnya dengan memeriksa nomor PKR terbesar yang sudah ada
  const data = sheetMaster.getDataRange().getValues();
  let maxIdNum = 0;
  const startIndex = MASTER_CONFIG.DATA_START_ROW - 1;

  for (let i = startIndex; i < data.length; i++) {
    const existingId = String(data[i][MASTER_CONFIG.COL_ID] || "").trim();
    const match = existingId.match(/^PKR-(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxIdNum) maxIdNum = num;
    }
  }

  const newIdNumber = maxIdNum + 1;
  const newId = "PKR-" + String(newIdNumber).padStart(3, "0");

  // Susun data pekerja baru dengan sanitasi formula injection
  const newRow = [
    newId,
    sanitasiFormula(nama),
    sanitasiFormula(keahlian),
    sanitasiFormula(proyekDefault),
    "Aktif",
    Number(payload.upah_harian || 0),
    Number(payload.tarif_lembur || 0)
  ];

  // Tentukan baris target secara eksplisit agar tidak salah jika ada baris kosong di tengah
  const lastRow = sheetMaster.getLastRow();
  const targetRow = Math.max(MASTER_CONFIG.DATA_START_ROW, lastRow + 1);

  if (targetRow > sheetMaster.getMaxRows()) {
    sheetMaster.insertRowsAfter(sheetMaster.getMaxRows(), targetRow - sheetMaster.getMaxRows() + 50);
  }

  sheetMaster.getRange(targetRow, 1, 1, MASTER_CONFIG.TOTAL_COLUMNS).setValues([newRow]);

  // Otomatis rapikan format, dropdown, warna, tinggi baris, dan lebar kolom di Master_Pekerja
  try {
    rapikanFormatBarisMaster_(sheetMaster, targetRow);
  } catch (fmtErr) {
    console.warn("Gagal merapikan format baris Master_Pekerja:", fmtErr.message);
  }

  // Otomatis sisipkan baris pekerja baru tepat di atas GRAND TOTAL pada tab Rekap_Upah
  try {
    sisipkanPekerjaKeRekap(ss, newId);
  } catch (rekapErr) {
    console.warn("Gagal menyisipkan ke Rekap_Upah:", rekapErr.message);
  }

  return createJsonResponse({
    status: "success",
    message: `Pekerja baru ${nama} (${newId}) berhasil didaftarkan.`,
    pekerja: {
      id_pekerja: newId,
      nama_pekerja: nama,
      keahlian: keahlian,
      proyek_default: proyekDefault
    }
  });
}

// =========================================================================
// 4. FUNGSI SIMPAN ABSENSI HARIAN (KE TAB Log_Absensi)
// =========================================================================
function handleKirimAbsensi(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetLog = ss.getSheetByName(CONFIG.SHEET_LOG);
  if (!sheetLog) {
    return createJsonResponse({ status: "error", message: `Tab '${CONFIG.SHEET_LOG}' tidak ditemukan.` });
  }

  // A. PENCEGAHAN DUPLIKASI DATA DENGAN SUBMISSION_ID (CACHE SERVICE)
  const submissionId = String(payload.submission_id || "").trim();
  const cache = CacheService.getScriptCache();
  if (submissionId) {
    const isProcessed = cache.get("sub_" + submissionId);
    if (isProcessed) {
      return createJsonResponse({
        status: "success",
        message: "Data absensi ini sudah berhasil tersimpan sebelumnya (pengiriman ganda dicegah).",
        duplicate: true
      });
    }
  }

  // B. VALIDASI INPUT SERVER-SIDE
  const namaProyek = String(payload.nama_proyek || "").trim();
  const namaOperator = String(payload.nama_operator || "").trim();
  const daftarAbsensi = payload.daftar_absensi || [];

  if (!namaProyek) {
    return createJsonResponse({ status: "error", message: "Nama Proyek wajib diisi." });
  }
  if (!namaOperator) {
    return createJsonResponse({ status: "error", message: "Nama Mandor / Operator wajib diisi." });
  }
  if (!Array.isArray(daftarAbsensi) || daftarAbsensi.length === 0) {
    return createJsonResponse({ status: "error", message: "Daftar absensi kosong. Minimal pilih 1 pekerja." });
  }

  // Validasi nilai kehadiran dan lembur per pekerja (0 = Absen, 0.5 = 1/2 Hari, 1 = Full, 2 = Lembur >6 jam)
  const validStatus = [0, 0.5, 1, 2];
  for (let i = 0; i < daftarAbsensi.length; i++) {
    const item = daftarAbsensi[i];
    const statusHadir = Number(item.status_hadir);
    const lembur = Number(item.jam_lembur || 0);

    if (!validStatus.includes(statusHadir)) {
      return createJsonResponse({
        status: "error",
        message: `Status hadir pekerja '${item.nama_pekerja || i}' tidak valid (${item.status_hadir}). Harus 1, 0.5, atau 0.`
      });
    }
    if (lembur < 0 || lembur > 12) {
      return createJsonResponse({
        status: "error",
        message: `Jam lembur pekerja '${item.nama_pekerja || i}' harus di antara 0 hingga 12 jam.`
      });
    }
    if (statusHadir === 0 && lembur > 0) {
      return createJsonResponse({
        status: "error",
        message: `Pekerja '${item.nama_pekerja || i}' berstatus Absen (0) tidak boleh memiliki jam lembur.`
      });
    }
  }

  // C. PENETAPAN TANGGAL & TIMESTAMP ASLI (OBJEK DATE UNTUK SHEETS)
  const now = new Date();
  const timestampDate = now; // Objek Date asli agar Sheets mengenalinya sebagai DateTime
  const tanggalDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // Objek Date asli (00:00:00) untuk kolom Tanggal
  const tanggalStr = Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy-MM-dd");
  const jamWib = Utilities.formatDate(now, CONFIG.TIMEZONE, "HH:mm");

  // D. UPLOAD FOTO KE GOOGLE DRIVE DENGAN ISOLASI ERROR
  let linkFoto = "-";
  if (payload.foto_base64 && CONFIG.FOLDER_FOTO_ID !== "GANTI_DENGAN_ID_FOLDER_GOOGLE_DRIVE") {
    try {
      linkFoto = simpanFotoKeDrive(
        payload.foto_base64,
        namaProyek,
        tanggalStr,
        jamWib
      );
    } catch (fotoErr) {
      // Jika terjadi kendala pada Drive, catat error di linkFoto dan JANGAN batalkan pencatatan absensi
      linkFoto = "Gagal upload: " + fotoErr.message;
      console.warn("Gagal mengunggah foto ke Drive: " + fotoErr.message);
    }
  }

  // E. PASTIKAN HEADER TAB LOG MEMILIKI 14 KOLOM (TERMASUK SUBMISSION_ID & GPS_STATUS)
  pastikanHeaderLogAbsensi(sheetLog);

  // F. SUSUN BARIS DATA SESUAI STRUKTUR 14 KOLOM
  const koordinatGps = String(payload.koordinat_gps || "-").trim();
  const gpsStatus = String(payload.gps_status || (koordinatGps !== "-" ? "ok" : "gagal")).trim();

  const rowsToInsert = daftarAbsensi.map(item => [
    timestampDate,                     // Kolom A: Timestamp (Date object)
    tanggalDate,                       // Kolom B: Tanggal (Date object)
    sanitasiFormula(namaProyek),       // Kolom C: Nama_Proyek
    sanitasiFormula(namaOperator),     // Kolom D: Nama_Operator
    sanitasiFormula(item.id_pekerja),   // Kolom E: ID_Pekerja
    sanitasiFormula(item.nama_pekerja), // Kolom F: Nama_Pekerja
    sanitasiFormula(item.keahlian),     // Kolom G: Keahlian
    Number(item.status_hadir),         // Kolom H: Status_Hadir (1, 0.5, 0)
    Number(item.jam_lembur || 0),      // Kolom I: Jam_Lembur (0 - 12)
    sanitasiFormula(koordinatGps),      // Kolom J: Koordinat_GPS
    linkFoto,                          // Kolom K: Link_Foto_Bukti
    sanitasiFormula(item.catatan),      // Kolom L: Catatan
    sanitasiFormula(submissionId),     // Kolom M: Submission_ID
    sanitasiFormula(gpsStatus)          // Kolom N: GPS_Status
  ]);

  // G. TULIS SECARA BATCH DALAM 1 TRANSAKSI DENGAN AUTO-EXPAND GRID
  const lastRow = sheetLog.getLastRow();
  const startRow = Math.max(LOG_CONFIG.DATA_START_ROW, lastRow + 1);
  const neededRow = startRow + rowsToInsert.length - 1;
  const maxRows = sheetLog.getMaxRows();

  // Jika baris yang dibutuhkan melebihi batas grid sheet saat ini, tambahkan baris baru otomatis
  if (neededRow > maxRows) {
    sheetLog.insertRowsAfter(maxRows, neededRow - maxRows + 200);
  }

  const range = sheetLog.getRange(startRow, 1, rowsToInsert.length, LOG_CONFIG.TOTAL_COLUMNS);
  range.setValues(rowsToInsert);

  // Format kolom Tanggal (B) agar rapi sebagai YYYY-MM-DD dan Timestamp (A) sebagai YYYY-MM-DD HH:mm:ss
  try {
    sheetLog.getRange(startRow, 1, rowsToInsert.length, 1).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    sheetLog.getRange(startRow, 2, rowsToInsert.length, 1).setNumberFormat("yyyy-mm-dd");
  } catch (fmtErr) {
    console.warn("Gagal format kolom tanggal:", fmtErr.message);
  }

  // H. CATAT SUBMISSION_ID KE DALAM CACHE (MASA AKTIF 6 JAM = 21600 DETIK)
  if (submissionId) {
    try {
      cache.put("sub_" + submissionId, "PROCESSED", 21600);
    } catch (cErr) {
      console.warn("Gagal menyimpan submission_id ke CacheService:", cErr.message);
    }
  }

  return createJsonResponse({
    status: "success",
    message: `Absensi ${rowsToInsert.length} pekerja berhasil tersimpan pada ${jamWib} WIB.`,
    jumlah_tersimpan: rowsToInsert.length,
    link_foto: linkFoto
  });
}

// =========================================================================
// 5. HELPER PENDUKUNG & KEAMANAN
// =========================================================================

/**
 * Deteksi pemisah argumen formula berdasarkan Locale Spreadsheet:
 * Locale Indonesia/Eropa umumnya memakai titik koma (;), sedangkan US/UK memakai koma (,).
 */
function getFormulaSeparator_(sheet) {
  try {
    const locale = sheet.getParent().getSpreadsheetLocale();
    const semicolonLocales = ["id", "de", "fr", "es", "it", "pt", "nl", "ru", "pl", "tr", "vi"];
    const langPrefix = String(locale || "").split("_")[0].toLowerCase();
    return semicolonLocales.includes(langPrefix) ? ";" : ",";
  } catch (e) {
    return ";";
  }
}

/**
 * Menyalin format visual (border, alignment, format Rp), validasi data (dropdown),
 * menjaga pola warna selang-seling, serta menyamakan tinggi baris & lebar kolom
 * pada tab Master_Pekerja.
 */
function rapikanFormatBarisMaster_(sheetMaster, targetRow) {
  if (targetRow <= MASTER_CONFIG.DATA_START_ROW) return;

  const sourceRow = targetRow - 1;
  const numCols = MASTER_CONFIG.TOTAL_COLUMNS;
  const sourceRange = sheetMaster.getRange(sourceRow, 1, 1, numCols);
  const targetRange = sheetMaster.getRange(targetRow, 1, 1, numCols);

  // Salin format visual (border, font, alignment, format angka/Rupiah)
  sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);

  // Salin aturan Data Validation (dropdown Keahlian & Status)
  sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);

  // Jaga pola warna selang-seling (zebra) agar tidak sama persis dengan baris tepat di atasnya
  if (targetRow - 2 >= MASTER_CONFIG.DATA_START_ROW) {
    const sameParityRow = targetRow - 2;
    const bgColors = sheetMaster.getRange(sameParityRow, 1, 1, numCols).getBackgrounds();
    targetRange.setBackgrounds(bgColors);
  }

  // Samakan tinggi baris dengan konfigurasi (atau baris sebelumnya jika ada)
  const rowHeight = MASTER_CONFIG.ROW_HEIGHT || sheetMaster.getRowHeight(sourceRow);
  if (rowHeight > 0) {
    sheetMaster.setRowHeight(targetRow, rowHeight);
  }

  // Samakan lebar kolom A-G sesuai konfigurasi
  if (Array.isArray(MASTER_CONFIG.COLUMN_WIDTHS)) {
    MASTER_CONFIG.COLUMN_WIDTHS.forEach((width, idx) => {
      if (width > 0) {
        sheetMaster.setColumnWidth(idx + 1, width);
      }
    });
  }
}

/**
 * Otomatis merapikan baris Master_Pekerja saat ID_Pekerja diisi secara manual di sheet.
 */
function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const row = e.range.getRow();
  const col = e.range.getColumn();

  if (
    sheetName === CONFIG.SHEET_MASTER &&
    row >= MASTER_CONFIG.DATA_START_ROW &&
    col === MASTER_CONFIG.COL_ID + 1
  ) {
    const val = String(e.range.getValue() || "").trim();
    if (val !== "") {
      rapikanFormatBarisMaster_(sheet, row);
    }
  }
}

/**
 * Pastikan baris header tab Log_Absensi memiliki kolom M dan N
 */
function pastikanHeaderLogAbsensi(sheetLog) {
  try {
    const headerRow = LOG_CONFIG.HEADER_ROW;
    const colM = sheetLog.getRange(headerRow, 13).getValue();
    const colN = sheetLog.getRange(headerRow, 14).getValue();

    if (!colM || !colN) {
      sheetLog.getRange(headerRow, 13, 1, 2).setValues([["Submission_ID", "GPS_Status"]]);
    }
  } catch (e) {
    console.warn("Gagal mengecek header Log_Absensi:", e.message);
  }
}

/**
 * Sanitasi Formula Injection:
 * Mencegah karakter =, +, -, @ dieksekusi sebagai rumus berbahaya di Google Sheets
 */
function sanitasiFormula(val) {
  if (val === null || val === undefined) return "";
  let str = String(val).trim();
  if (/^[=+\-@]/.test(str)) {
    return "'" + str; // Tambahkan kutip tunggal agar dibaca sebagai teks literal
  }
  return str;
}

/**
 * Verifikasi PIN dengan Brute-Force Rate Limiting (Maksimal 5x salah per 10 menit)
 */
function verifikasiAksesPin(inputPin) {
  const pinInput = String(inputPin || "").trim();
  const scriptProps = PropertiesService.getScriptProperties();
  const secretPin = scriptProps.getProperty("PIN_PROYEK") || CONFIG.DEFAULT_PIN;

  const cache = CacheService.getScriptCache();
  const attemptKey = "pin_failed_attempts";
  const attempts = parseInt(cache.get(attemptKey) || "0", 10);

  if (attempts >= 5) {
    return {
      valid: false,
      message: "Terlalu banyak percobaan PIN salah. Akses ditangguhkan selama beberapa menit."
    };
  }

  if (pinInput !== secretPin) {
    cache.put(attemptKey, String(attempts + 1), 600); // Kunci 10 menit
    return {
      valid: false,
      message: "PIN Proyek tidak valid. Silakan periksa kembali."
    };
  }

  // Jika PIN benar, reset counter kesalahan
  cache.remove(attemptKey);
  return { valid: true };
}

/**
 * Simpan Foto Base64 ke Folder Google Drive
 */
function simpanFotoKeDrive(base64String, namaProyek, tanggalStr, jamWib) {
  const cleanBase64 = base64String.includes(",") ? base64String.split(",")[1] : base64String;

  // Validasi ukuran base64 di server (maksimal ~1 MB untuk mencegah abuse)
  const byteSize = (cleanBase64.length * 3) / 4;
  if (byteSize > 1024 * 1024) {
    throw new Error("Ukuran foto melebihi batas server (1 MB).");
  }

  const decodedBytes = Utilities.base64Decode(cleanBase64);
  const safeProyekName = (namaProyek || "Proyek").replace(/[^a-zA-Z0-9_\-]/g, "_");
  const safeJam = (jamWib || "0000").replace(":", "");
  const namaFile = `Absensi_${safeProyekName}_${tanggalStr}_${safeJam}.jpg`;

  const blob = Utilities.newBlob(decodedBytes, "image/jpeg", namaFile);
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_FOTO_ID);
  const file = folder.createFile(blob);

  // Konfigurasi hak akses sharing foto
  if (CONFIG.SHARE_FOTO_PUBLIC) {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }

  return file.getUrl();
}

/**
 * Format Respons JSON dengan Header Mime-Type yang Sesuai
 */
function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// =========================================================================
// 6. OTOMASI TAB Rekap_Upah (DYNAMIC FORMULAS & AUTO-EXPAND)
// =========================================================================

/**
 * Cari posisi baris GRAND TOTAL di Rekap_Upah.
 * Mengembalikan nomor baris 1-based, atau -1 jika tidak ditemukan.
 */
function cariGrandTotalRow_(sheetRekap) {
  const data = sheetRekap.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || "").trim().toUpperCase() === REKAP_CONFIG.GRAND_TOTAL_TEXT) {
      return i + 1; // 1-based
    }
  }
  return -1;
}

/**
 * Memperbarui seluruh formula di Rekap_Upah secara dinamis, anti-error, dan otomatis
 * menyesuaikan pemisah argumen locale spreadsheet (; atau ,).
 */
function perbaruiSemuaFormulaRekap_(sheetRekap) {
  const grandTotalRow = cariGrandTotalRow_(sheetRekap);
  if (grandTotalRow === -1) return;

  const startRow = REKAP_CONFIG.DATA_START_ROW; // Baris 11
  const endRow = grandTotalRow - 1;

  if (endRow < startRow) return; // Belum ada baris data pekerja

  const sep = getFormulaSeparator_(sheetRekap); // ";" untuk locale Indonesia, "," untuk US
  const jumlahPekerja = endRow - startRow + 1;

  // 1. Susun batch formula dinamis untuk setiap baris data pekerja (Kolom B sampai M = 12 kolom formula)
  const workerFormulas = [];
  for (let r = startRow; r <= endRow; r++) {
    const fNama = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 2${sep} FALSE)${sep} "")`;
    const fKeahlian = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 3${sep} FALSE)${sep} "")`;
    const fProyek = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 4${sep} FALSE)${sep} "")`;
    const fStatus = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 5${sep} FALSE)${sep} "")`;
    const fUpah = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 6${sep} FALSE)${sep} 0)`;
    const fLembur = `=IFERROR(VLOOKUP(A${r}${sep} Master_Pekerja!$A$5:$G$1000${sep} 7${sep} FALSE)${sep} 0)`;

    // Kolom H: Total Hari Kerja (kehadiran 2 dari lembur >6 jam otomatis menambah 2 hari kerja)
    const fHariKerja =
      `=IF(A${r}=""${sep} 0${sep} ` +
      `IFERROR(IF(AND($C$3<>""${sep} $E$3<>"")${sep} ` +
      `SUMIFS(Log_Absensi!$H$5:$H$10000${sep} Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$B$5:$B$10000${sep} ">="&$C$3${sep} Log_Absensi!$B$5:$B$10000${sep} "<="&$E$3)${sep} ` +
      `SUMIF(Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$H$5:$H$10000))${sep} 0))`;

    // Kolom I: Total Jam Lembur (lembur normal <= 6 jam)
    const fJamLembur =
      `=IF(A${r}=""${sep} 0${sep} ` +
      `IFERROR(IF(AND($C$3<>""${sep} $E$3<>"")${sep} ` +
      `SUMIFS(Log_Absensi!$I$5:$I$10000${sep} Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$B$5:$B$10000${sep} ">="&$C$3${sep} Log_Absensi!$B$5:$B$10000${sep} "<="&$E$3)${sep} ` +
      `SUMIF(Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$I$5:$I$10000))${sep} 0))`;

    // Kolom J: Total Uang Makan (dihitung dari jumlah hari lembur >6 jam, yaitu Status_Hadir >= 2)
    const fUangMakan =
      `=IF(A${r}=""${sep} 0${sep} ` +
      `IFERROR(IF(AND($C$3<>""${sep} $E$3<>"")${sep} ` +
      `COUNTIFS(Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$H$5:$H$10000${sep} ">=2"${sep} Log_Absensi!$B$5:$B$10000${sep} ">="&$C$3${sep} Log_Absensi!$B$5:$B$10000${sep} "<="&$E$3)${sep} ` +
      `COUNTIFS(Log_Absensi!$E$5:$E$10000${sep} A${r}${sep} Log_Absensi!$H$5:$H$10000${sep} ">=2"))${sep} 0))`;

    // Kolom K: Upah Pokok (H * F)
    const fUpahPokok = `=IFERROR(H${r}*F${r}${sep} 0)`;
    // Kolom L: Upah Lembur (I * G)
    const fUpahLembur = `=IFERROR(I${r}*G${r}${sep} 0)`;
    // Kolom M: Total Upah (K + L)
    const fTotalUpah = `=IFERROR(K${r}+L${r}${sep} 0)`;

    workerFormulas.push([
      fNama,
      fKeahlian,
      fProyek,
      fStatus,
      fUpah,
      fLembur,
      fHariKerja,
      fJamLembur,
      fUangMakan,
      fUpahPokok,
      fUpahLembur,
      fTotalUpah
    ]);
  }

  // Pastikan baris header 10 memiliki kolom J = Total_Uang_Makan, K = Upah_Pokok, L = Upah_Lembur, M = Total_Upah
  try {
    sheetRekap.getRange(10, 10, 1, 4).setValues([["Total_Uang_Makan", "Upah_Pokok", "Upah_Lembur", "Total_Upah"]]);
  } catch (hdrErr) {}

  // Terapkan formula ke seluruh baris data pekerja secara batch (Kolom B sampai M = 12 kolom)
  sheetRekap.getRange(startRow, 2, jumlahPekerja, 12).setFormulas(workerFormulas);

  // 2. Perbarui formula di baris GRAND TOTAL (Kolom H sampai M = 6 kolom)
  const grandTotalFormulas = [[
    `=IFERROR(SUM(H${startRow}:H${endRow})${sep} 0)`, // Kolom H: Total Hari Kerja
    `=IFERROR(SUM(I${startRow}:I${endRow})${sep} 0)`, // Kolom I: Total Jam Lembur
    `=IFERROR(SUM(J${startRow}:J${endRow})${sep} 0)`, // Kolom J: Total Uang Makan
    `=IFERROR(SUM(K${startRow}:K${endRow})${sep} 0)`, // Kolom K: Upah Pokok
    `=IFERROR(SUM(L${startRow}:L${endRow})${sep} 0)`, // Kolom L: Upah Lembur
    `=IFERROR(SUM(M${startRow}:M${endRow})${sep} 0)`  // Kolom M: Total Upah
  ]];
  sheetRekap.getRange(grandTotalRow, 8, 1, 6).setFormulas(grandTotalFormulas);

  // 3. Perbarui formula KPI (Baris 7)
  try {
    sheetRekap.getRange("B7").setFormula(`=IFERROR(COUNTIF(E${startRow}:E${endRow}${sep} "Aktif")${sep} 0)`);
    sheetRekap.getRange("D7").setFormula(`=IFERROR(SUM(H${startRow}:H${endRow})${sep} 0)`);
    sheetRekap.getRange("G7").setFormula(`=IFERROR(SUM(I${startRow}:I${endRow})${sep} 0)`);
    sheetRekap.getRange("J7").setFormula(`=IFERROR(SUM(M${startRow}:M${endRow})${sep} 0)`); // Kolom M: Total Estimasi Upah
  } catch (kpiErr) {
    console.warn("Gagal update formula KPI row 7:", kpiErr.message);
  }

  // 4. Format Angka (Currency & Desimal)
  try {
    sheetRekap.getRange(startRow, 6, jumlahPekerja, 2).setNumberFormat("#,##0");
    sheetRekap.getRange(startRow, 8, jumlahPekerja, 2).setNumberFormat("#,##0.0");
    sheetRekap.getRange(startRow, 10, jumlahPekerja, 1).setNumberFormat("#,##0"); // Kolom J: Uang Makan (integer)
    sheetRekap.getRange(startRow, 11, jumlahPekerja, 3).setNumberFormat("#,##0"); // Kolom K, L, M: Rupiah
    sheetRekap.getRange(grandTotalRow, 8, 1, 2).setNumberFormat("#,##0.0");
    sheetRekap.getRange(grandTotalRow, 10, 1, 4).setNumberFormat("#,##0");
  } catch (fmtErr) {
    console.warn("Gagal format angka:", fmtErr.message);
  }
}

/**
 * Sisipkan 1 baris pekerja baru tepat di atas baris GRAND TOTAL pada tab Rekap_Upah.
 * Formula dan format diperbarui otomatis agar sepenuhnya dinamis.
 */
function sisipkanPekerjaKeRekap(ss, newId) {
  const sheetRekap = ss.getSheetByName(REKAP_CONFIG.SHEET_NAME);
  if (!sheetRekap) return;

  const data = sheetRekap.getDataRange().getValues();
  let grandTotalRow = -1;

  for (let i = 0; i < data.length; i++) {
    const colA = String(data[i][0] || "").trim().toUpperCase();
    if (colA === REKAP_CONFIG.GRAND_TOTAL_TEXT) {
      grandTotalRow = i + 1;
      break;
    }
  }
  if (grandTotalRow === -1) {
    grandTotalRow = Math.max(REKAP_CONFIG.DATA_START_ROW, sheetRekap.getLastRow() + 1);
    sheetRekap.getRange(grandTotalRow, 1).setValue(REKAP_CONFIG.GRAND_TOTAL_TEXT);
  }

  // Cek apakah ID pekerja ini sudah ada agar tidak duplikat
  for (let i = 0; i < grandTotalRow - 1; i++) {
    if (String(data[i][0] || "").trim().toUpperCase() === newId.toUpperCase()) {
      return;
    }
  }

  // Sisipkan 1 baris baru tepat di atas GRAND TOTAL
  sheetRekap.insertRowBefore(grandTotalRow);

  // Isi ID pekerja di kolom A baris baru
  sheetRekap.getRange(grandTotalRow, 1).setValue(newId);

  // Format baris baru (13 kolom: A sampai M)
  const newRowRange = sheetRekap.getRange(grandTotalRow, 1, 1, 13);
  newRowRange.setBorder(true, true, true, true, true, true, "#d1d5db", SpreadsheetApp.BorderStyle.SOLID);
  newRowRange.setFontFamily("Arial");
  newRowRange.setFontSize(10);
  newRowRange.setBackground("#ffffff");
  sheetRekap.getRange(grandTotalRow, 1).setHorizontalAlignment("center");
  sheetRekap.getRange(grandTotalRow, 5).setHorizontalAlignment("center");
  sheetRekap.getRange(grandTotalRow, 6, 1, 8).setHorizontalAlignment("right");

  // Perbarui seluruh formula di sheet agar dinamis dan anti-error
  perbaruiSemuaFormulaRekap_(sheetRekap);
}

/**
 * Fungsi untuk memeriksa seluruh pekerja di Master dan menyisipkan
 * siapa pun yang belum ada di Rekap_Upah
 */
function sinkronkanSemuaPekerjaKeRekap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetMaster = ss.getSheetByName(CONFIG.SHEET_MASTER);
  const sheetRekap = ss.getSheetByName(REKAP_CONFIG.SHEET_NAME);
  if (!sheetMaster || !sheetRekap) return;

  const masterData = sheetMaster.getDataRange().getValues();

  // Kumpulkan ID pekerja dari tab Master (mulai baris ke-5)
  const startIndex = MASTER_CONFIG.DATA_START_ROW - 1;
  const daftarIdMaster = [];
  for (let m = startIndex; m < masterData.length; m++) {
    const idPekerja = String(masterData[m][MASTER_CONFIG.COL_ID] || "").trim();
    if (idPekerja && idPekerja.toUpperCase() !== "ID_PEKERJA" && /^PKR-\d+$/i.test(idPekerja)) {
      daftarIdMaster.push(idPekerja);
    }
  }

  let jumlahDitambah = 0;
  for (let i = 0; i < daftarIdMaster.length; i++) {
    const idPekerja = daftarIdMaster[i];
    const rekapData = sheetRekap.getDataRange().getValues();
    const existingInRekap = new Set(
      rekapData.map(r => String(r[0] || "").trim().toUpperCase()).filter(Boolean)
    );
    if (!existingInRekap.has(idPekerja.toUpperCase())) {
      sisipkanPekerjaKeRekap(ss, idPekerja);
      jumlahDitambah++;
    }
  }

  // Pastikan formula selalu fresh dan dinamis
  perbaruiSemuaFormulaRekap_(sheetRekap);

  SpreadsheetApp.getUi().alert(
    "✅ Sinkronisasi Selesai",
    `${daftarIdMaster.length} pekerja diperiksa. ${jumlahDitambah} pekerja baru ditambahkan ke Rekap_Upah.\nSeluruh formula dan kalkulasi telah diperbarui dinamis anti-error.`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * REBUILD TOTAL: Hapus semua baris pekerja lama di Rekap_Upah dan susun ulang
 * dari baris 11 berdasarkan urutan PKR di Master_Pekerja.
 * Mengaplikasikan formula dinamis anti-error ke seluruh baris.
 */
function rebuildRekapUpah() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetMaster = ss.getSheetByName(CONFIG.SHEET_MASTER);
  const sheetRekap = ss.getSheetByName(REKAP_CONFIG.SHEET_NAME);

  if (!sheetMaster || !sheetRekap) {
    ui.alert("Error: Tab Master_Pekerja atau Rekap_Upah tidak ditemukan!");
    return;
  }

  const konfirmasi = ui.alert(
    "⚠️ Rebuild Rekap Upah",
    "Semua baris pekerja di Rekap_Upah akan dihapus dan disusun ulang dari awal " +
    "sesuai urutan PKR di Master_Pekerja.\n\n" +
    "Seluruh formula (VLOOKUP, SUMIFS, Upah Pokok, Upah Lembur, GRAND TOTAL, KPI) " +
    "akan diatur otomatis secara dinamis.\n\nLanjutkan?",
    ui.ButtonSet.YES_NO
  );
  if (konfirmasi !== ui.Button.YES) return;

  // 1. Ambil semua PKR dari Master, urutkan berdasarkan nomor
  const masterData = sheetMaster.getDataRange().getValues();
  const startIndex = MASTER_CONFIG.DATA_START_ROW - 1;
  const daftarPKR = [];
  for (let m = startIndex; m < masterData.length; m++) {
    const id = String(masterData[m][MASTER_CONFIG.COL_ID] || "").trim();
    if (id && /^PKR-\d+$/i.test(id)) daftarPKR.push(id);
  }
  daftarPKR.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  if (daftarPKR.length === 0) {
    ui.alert("⚠️ Tidak ada data pekerja di Master_Pekerja. Tambahkan pekerja terlebih dahulu.");
    return;
  }

  // 2. Cari posisi GRAND TOTAL
  let grandTotalRow = cariGrandTotalRow_(sheetRekap);
  if (grandTotalRow === -1) {
    ui.alert(
      "Error: Baris GRAND TOTAL tidak ditemukan!\n\n" +
      "Pastikan ada 1 baris di Rekap_Upah dengan teks 'GRAND TOTAL' di kolom A."
    );
    return;
  }

  const dataStartRow = REKAP_CONFIG.DATA_START_ROW;

  // 3. Hapus semua baris data antara dataStartRow dan grandTotalRow (exclusive)
  const jumlahRowLama = grandTotalRow - dataStartRow;
  if (jumlahRowLama > 0) {
    sheetRekap.deleteRows(dataStartRow, jumlahRowLama);
    grandTotalRow -= jumlahRowLama;
  }

  // 4. Sisipkan baris-baris baru untuk setiap pekerja
  for (let i = 0; i < daftarPKR.length; i++) {
    sheetRekap.insertRowBefore(grandTotalRow);
    const newRow = grandTotalRow;
    grandTotalRow++;

    sheetRekap.getRange(newRow, 1).setValue(daftarPKR[i]);

    const newRowRange = sheetRekap.getRange(newRow, 1, 1, 13);
    newRowRange.setBorder(true, true, true, true, true, true, "#d1d5db", SpreadsheetApp.BorderStyle.SOLID);
    newRowRange.setFontFamily("Arial");
    newRowRange.setFontSize(10);
    newRowRange.setBackground("#ffffff");
    sheetRekap.getRange(newRow, 1).setHorizontalAlignment("center");
    sheetRekap.getRange(newRow, 5).setHorizontalAlignment("center");
    sheetRekap.getRange(newRow, 6, 1, 8).setHorizontalAlignment("right");
  }

  // 5. Terapkan seluruh formula dinamis
  perbaruiSemuaFormulaRekap_(sheetRekap);

  ui.alert(
    "✅ Rebuild Selesai",
    `${daftarPKR.length} pekerja telah disusun ulang di Rekap_Upah (baris ${dataStartRow} s/d ${grandTotalRow - 1}).\n` +
    `Seluruh formula telah disinkronkan secara dinamis.`,
    ui.ButtonSet.OK
  );
}

/**
 * Menu manual untuk memperbarui formula di Rekap_Upah kapan saja
 */
function perbaruiFormulaRekapManual() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetRekap = ss.getSheetByName(REKAP_CONFIG.SHEET_NAME);
  if (!sheetRekap) return;
  perbaruiSemuaFormulaRekap_(sheetRekap);
  SpreadsheetApp.getUi().alert(
    "✅ Formula Berhasil Diperbarui",
    "Seluruh formula pada tab Rekap_Upah telah diperbarui.",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * Membuat Tombol Menu Otomatis di Google Sheets
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚙️ Sistem Absensi")
    .addItem("🔄 Sinkronkan Pekerja ke Rekap Upah", "sinkronkanSemuaPekerjaKeRekap")
    .addItem("⚡ Perbarui Seluruh Formula Dinamis", "perbaruiFormulaRekapManual")
    .addItem("🔨 Rebuild Ulang Rekap Upah (Fix Posisi)", "rebuildRekapUpah")
    .addToUi();
}