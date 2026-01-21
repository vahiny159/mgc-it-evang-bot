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
const MONGO_URI = process.env.MONGO_URI;
const WEB_APP_URL =
  process.env.RENDER_EXTERNAL_URL || "https://ton-projet.onrender.com";

// --- MIDDLEWARES ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Base de Données Connectée (MongoDB)"))
  .catch((err) => console.error("❌ Erreur de connexion DB:", err));

const StudentSchema = new mongoose.Schema({
  readableId: { type: String, unique: true },
  nomComplet: { type: String, required: true },
  telephone: String,
  dateNaissance: String,
  adresse: String,
  eglise: String,
  profession: String,
  option: String,

  idApp: String,
  nomTree: String,
  telTree: String,
  liaison: String,
  departement: String,

  createdByTelegramId: Number,
  dateAjout: { type: Date, default: Date.now },
});

const Student = mongoose.model("Student", StudentSchema);

// --- SÉCURITÉ(auth) ---
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

// --- API : ENREGISTREMENT ---
app.post("/api/students", async (req, res) => {
  try {
    const telegramProof = req.header("X-Telegram-Data");
    let telegramUserId = null;

    // Sécurité
    if (telegramProof && verifyTelegramData(telegramProof)) {
      const userData = new URLSearchParams(telegramProof).get("user");
      const user = JSON.parse(userData);
      telegramUserId = user.id;
      console.log(`✅ Ajout par utilisateur certifié : ${user.first_name}`);
    } else {
      console.log("⚠️ Ajout hors Telegram ou non sécurisé");
    }

    const data = req.body;

    const shortId = Math.floor(100000 + Math.random() * 900000).toString();

    const newStudent = new Student({
      ...data,
      readableId: shortId,
      createdByTelegramId: telegramUserId,
    });

    // SAUVEGARDE DANS LE CLOUD
    await newStudent.save();
    console.log(`📝 Élève sauvegardé en BDD : ${newStudent.nomComplet}`);

    // ENVOI NOTIFICATION TELEGRAM
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

// --- API : CHECK DOUBLONS ---
app.post("/api/check-duplicates", async (req, res) => {
  try {
    const { nomComplet, telephone } = req.body;
    let query = { $or: [] };

    if (telephone) {
      query.$or.push({ telephone: telephone });
    }
    if (nomComplet) {
      query.$or.push({ nomComplet: { $regex: new RegExp(nomComplet, "i") } });
    }

    if (query.$or.length === 0) return res.json({ found: false });

    const candidates = await Student.find(query).limit(5);

    res.json({ found: candidates.length > 0, candidates: candidates });
  } catch (e) {
    console.error("Erreur doublon:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- API : LISTE DES ÉLÈVES JUSTE POUR LE TEST (admin.html)---
app.get("/api/students", async (req, res) => {
  const password = req.query.pwd;

  if (password !== "Secret123") {
    return res
      .status(403)
      .json({ error: "Accès refusé. Mot de passe incorrect." });
  }

  try {
    const allStudents = await Student.find().sort({ dateAjout: -1 });
    res.json(allStudents);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BOT (INTERFACE) ---
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
