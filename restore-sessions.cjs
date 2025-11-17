const fs = require("fs");
const path = require("path");

const exportPath = path.join(__dirname, "sessions-export.json");
const sessionsDir = path.join(__dirname, "data", "sessions");

if (!fs.existsSync(exportPath)) {
  console.error("No encuentro sessions-export.json en esta carpeta.");
  process.exit(1);
}

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Lee el JSON tolerando BOM / codificaciones raras
function loadExportJson(filePath) {
  const buf = fs.readFileSync(filePath);

  // 1) Intento como UTF-8 normal, quitando BOM si existe
  let text = buf.toString("utf8").replace(/^\uFEFF/, "");

  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn("⚠ JSON no válido como UTF-8 puro, probando como utf16le...");
    // 2) Reintento asumiendo que el archivo está en UTF-16 LE
    text = buf.toString("utf16le").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  }
}

let data;
try {
  data = loadExportJson(exportPath);
} catch (e) {
  console.error("❌ No pude parsear sessions-export.json como JSON:");
  console.error(e.message);
  process.exit(1);
}

if (!data || !Array.isArray(data.sessions)) {
  console.error("❌ El archivo no tiene la forma { sessions: [...] }");
  process.exit(1);
}

console.log(`Restaurando ${data.sessions.length} sesiones...`);

for (const item of data.sessions) {
  if (!item || !item.id || !item.session) continue;
  const fileName = path.join(sessionsDir, `${item.id}.json`);
  fs.writeFileSync(fileName, JSON.stringify(item.session, null, 2), "utf8");
  console.log(`✅ Guardada sesión: ${fileName}`);
}

console.log("✨ Listo. Sesiones restauradas:", data.sessions.length);
