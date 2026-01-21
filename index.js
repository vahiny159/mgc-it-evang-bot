require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const crypto = require("crypto");

// --- CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI; // Ton lien MongoDB
const WEB_APP_URL =
  process.env.RENDER_EXTERNAL_URL || "https://ton-projet.onrender.com";

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 1. CONNEXION MONGODB ---
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Base de Données Connectée (MongoDB)"))
  .catch((err) => console.error("❌ Erreur de connexion DB:", err));

// --- 2. DÉFINITION DU MODÈLE (SCHEMA) ---
// C'est la structure exacte de ton dossier élève
const StudentSchema = new mongoose.Schema({
  readableId: { type: String, unique: true }, // ID court pour l'affichage (ex: 839201)
  nomComplet: { type: String, required: true },
  telephone: String,
  dateNaissance: String,
  adresse: String,
  eglise: String,
  profession: String,
  option: String, // Journalier / Weekend

  // Champs Tree / Parrainage
  idApp: String,
  nomTree: String,
  telTree: String,
  liaison: String,
  departement: String,

  // Métadonnées
  createdByTelegramId: Number,
  dateAjout: { type: Date, default: Date.now },
});

const Student = mongoose.model("Student", StudentSchema);

// --- 3. SÉCURITÉ ---
const verifyTelegramData = (initData) => {
  if (!initData) return false;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  urlParams.delete("hash");
  const dataCheckString = Array.from(urlParams.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => `${key}=${val}`)
    .join("\n");
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  return calculatedHash === hash;
};

// --- 4. API : ENREGISTREMENT ---
app.post("/api/students", async (req, res) => {
  try {
    const telegramProof = req.header("X-Telegram-Data");
    let telegramUserId = null;

    // Vérification Sécurité
    if (telegramProof && verifyTelegramData(telegramProof)) {
      const userData = new URLSearchParams(telegramProof).get("user");
      const user = JSON.parse(userData);
      telegramUserId = user.id;
      console.log(`✅ Ajout par utilisateur certifié : ${user.first_name}`);
    } else {
      console.log("⚠️ Ajout hors Telegram ou non sécurisé");
    }

    // Préparation des données
    const data = req.body;

    // Génération d'un ID court (6 chiffres) unique
    const shortId = Math.floor(100000 + Math.random() * 900000).toString();

    const newStudent = new Student({
      ...data, // On copie tous les champs du formulaire
      readableId: shortId,
      createdByTelegramId: telegramUserId,
    });

    // SAUVEGARDE DANS LE CLOUD ☁️
    await newStudent.save();
    console.log(`📝 Élève sauvegardé en BDD : ${newStudent.nomComplet}`);

    // ENVOI NOTIFICATION TELEGRAM (Si possible)
    if (BOT_TOKEN && telegramUserId) {
      try {
        const bot = new Telegraf(BOT_TOKEN);
        await bot.telegram.sendMessage(
          telegramUserId,
          `✅ **Dossier Enregistré !**\n👤 ${newStudent.nomComplet}\n🆔 Ticket : ${shortId}`,
        );
      } catch (e) {
        console.error("Erreur notif bot:", e.message);
      }
    }

    res.json({ success: true, id: shortId });
  } catch (e) {
    console.error("Erreur API:", e);
    res.status(500).json({ success: false, message: "Erreur enregistrement" });
  }
});

// --- 5. API : DÉTECTION DOUBLONS ---
app.post("/api/check-duplicates", async (req, res) => {
  try {
    const { nomComplet, telephone } = req.body;
    let query = { $or: [] };

    if (telephone) {
      // Recherche exacte sur le téléphone
      query.$or.push({ telephone: telephone });
    }
    if (nomComplet) {
      // Recherche flexible sur le nom (insensible à la casse)
      query.$or.push({ nomComplet: { $regex: new RegExp(nomComplet, "i") } });
    }

    if (query.$or.length === 0) return res.json({ found: false });

    // RECHERCHE DANS LE CLOUD ☁️
    const candidates = await Student.find(query).limit(5);

    res.json({ found: candidates.length > 0, candidates: candidates });
  } catch (e) {
    console.error("Erreur doublon:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- API : LISTE DES ÉLÈVES (ADMIN) ---
app.get("/api/students", async (req, res) => {
  // 1. Petite sécurité basique (Mot de passe dans l'URL)
  // On attendra une requête du type : /api/students?pwd=MON_MOT_DE_PASSE
  const password = req.query.pwd;

  // Remplace "Secret123" par le mot de passe de ton choix
  if (password !== "Secret123") {
    return res
      .status(403)
      .json({ error: "Accès refusé. Mot de passe incorrect." });
  }

  try {
    // 2. On récupère tout le monde, du plus récent au plus ancien
    const allStudents = await Student.find().sort({ dateAjout: -1 });
    res.json(allStudents);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 6. LE BOT (INTERFACE) ---
if (BOT_TOKEN) {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply(
      "👋 **MGC Inscriptions**\nBase de données connectée.\nCliquez pour ouvrir :",
      Markup.keyboard([
        [Markup.button.webApp("📝 Ouvrir le Formulaire", WEB_APP_URL)],
      ]).resize(),
    );
  });

  // Nettoyage Webhook au lancement pour éviter les bugs
  bot.telegram
    .deleteWebhook()
    .then(() => {
      bot.launch();
      console.log("🤖 Bot Pro En Ligne !");
    })
    .catch(console.error);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

app.listen(PORT, () => console.log(`🚀 Serveur Pro lancé sur le port ${PORT}`));
