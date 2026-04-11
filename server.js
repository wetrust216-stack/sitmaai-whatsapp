app.post("/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Dial>+966542005950</Dial>
    </Response>
  `);
});

const express = require("express");
const { google } = require("googleapis");
const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({
  version: "v4",
  auth
});

const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID ||
  "15-mvbqeRaJZsVD_eziUecqwRVmaiAjXb_SuoQ7kbQ24";


/* =========================
   HELPERS
========================= */

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function normalizeArabic(text) {
  if (!text) return "";

  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ء/g, "")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/\s+/g, " ");
}

function buildTwiml(message) {
  const safe = String(message || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Message>${safe}</Message>
</Response>`;
}

function parseHour(value) {
  if (!value) return null;

  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?$/);

  if (!match) return null;

  const hour = parseInt(match[1]);
  const minute = match[2] ? parseInt(match[2]) : 0;

  return hour + minute / 60;
}

function isWithinDoctorHours(userTime, start, end) {
  const requested = parseHour(userTime);
  const s = parseHour(start);
  const e = parseHour(end);

  if (requested === null || s === null || e === null) return true;

  return requested >= s && requested <= e;
}

function generateBookingId() {
  return `BK-${Date.now()}`;
}


/* =========================
   GOOGLE SHEETS
========================= */

async function getSheetRows(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });

  return res.data.values || [];
}

async function getDoctors() {
  const rows = await getSheetRows("Doctors!A2:F");

  return rows.map((row, i) => ({
    rowIndex: i + 2,
    Doctor: row[0] || "",
    Specialty: row[1] || "",
    AvailableDays: row[2] || "",
    StartTime: row[3] || "",
    EndTime: row[4] || "",
    Status: row[5] || ""
  }));
}

async function getBookings() {
  const rows = await getSheetRows("Bookings!A2:J");

  return rows.map((row) => ({
    BookingID: row[0],
    User: row[1],
    Name: row[2],
    Doctor: row[3],
    Specialty: row[4],
    Day: row[5],
    Time: row[6],
    Status: row[7]
  }));
}

async function getSessions() {
  const rows = await getSheetRows("Sessions!A2:I");

  return rows.map((row, i) => ({
    rowIndex: i + 2,
    User: row[0] || "",
    Intent: row[1] || "",
    Doctor: row[2] || "",
    Specialty: row[3] || "",
    Day: row[4] || "",
    Time: row[5] || "",
    Name: row[6] || "",
    LastMessage: row[7] || ""
  }));
}

async function getSessionByUser(user) {
  const sessions = await getSessions();

  return sessions.find((s) => s.User === user);
}

async function createOrUpdateSession(data) {
  const existing = await getSessionByUser(data.User);

  const values = [[
    data.User,
    data.Intent,
    data.Doctor,
    data.Specialty,
    data.Day,
    data.Time,
    data.Name,
    data.LastMessage,
    new Date().toLocaleString()
  ]];

  if (existing) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sessions!A${existing.rowIndex}:I${existing.rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sessions!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
  }
}

async function clearSession(user) {
  const existing = await getSessionByUser(user);

  if (!existing) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sessions!A${existing.rowIndex}:I${existing.rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["","","","","","","","",""]]
    }
  });
}

async function saveBooking(data) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Bookings!A:J",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        generateBookingId(),
        data.user,
        data.name,
        data.doctor,
        data.specialty,
        data.day,
        data.time,
        "Confirmed",
        new Date().toLocaleString(),
        ""
      ]]
    }
  });
}


/* =========================
   LOGIC
========================= */

function isDoctorActive(doctor) {
  return normalizeText(doctor.Status).toLowerCase() === "active";
}

function findDoctorByName(doctors, doctorName) {
  return doctors.find((d) =>
    normalizeArabic(d.Doctor).includes(normalizeArabic(doctorName))
  );
}

function findDoctorsBySpecialty(doctors, specialty) {
  return doctors.filter((d) =>
    normalizeArabic(d.Specialty).includes(normalizeArabic(specialty))
  );
}

function formatDoctorsList(doctors) {
  return doctors
    .map(
      (d, i) =>
        `${i + 1}- د. ${d.Doctor} - ${d.Specialty} (${d.StartTime} إلى ${d.EndTime})`
    )
    .join("\n");
}


/* =========================
   AI
========================= */

async function analyzeMessage(message, session, doctors) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,

    messages: [
      {
        role: "system",
        content: `
أنت موظف استقبال طبي ذكي.

ارجع JSON فقط:

{
"intent":"",
"doctor":"",
"specialty":"",
"day":"",
"time":"",
"name":"",
"reply":""
}

intent values:
booking
ask_doctors
ask_hours
cancel
normal

استخرج البيانات فقط.
`
      },

      {
        role: "user",
        content: message
      }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
}


/* =========================
   WEBHOOK
========================= */

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = normalizeText(req.body.Body);

    const userNumber = String(req.body.From).replace("whatsapp:", "");

    const doctors = (await getDoctors()).filter(isDoctorActive);

    let session =
      (await getSessionByUser(userNumber)) || {
        User: userNumber,
        Doctor: "",
        Specialty: "",
        Day: "",
        Time: "",
        Name: ""
      };

    const ai = await analyzeMessage(incomingMsg, session, doctors);


    if (ai.intent === "cancel") {
      await clearSession(userNumber);

      return res.send(buildTwiml("تم إلغاء العملية."));
    }


    if (
      ai.intent === "ask_doctors" &&
      !session.Doctor &&
      !session.Specialty
    ) {
      return res.send(
        buildTwiml("الأطباء المتاحون:\n" + formatDoctorsList(doctors))
      );
    }


    let nextSession = {
      User: userNumber,
      Intent: "booking",
      Doctor: ai.doctor || session.Doctor,
      Specialty: ai.specialty || session.Specialty,
      Day: ai.day || session.Day,
      Time: ai.time || session.Time,
      Name: ai.name || session.Name,
      LastMessage: incomingMsg
    };


    for (const doctor of doctors) {
      if (
        !nextSession.Doctor &&
        normalizeArabic(incomingMsg).includes(normalizeArabic(doctor.Doctor))
      ) {
        nextSession.Doctor = doctor.Doctor;
        nextSession.Specialty = doctor.Specialty;
      }

      if (
        !nextSession.Specialty &&
        normalizeArabic(incomingMsg).includes(normalizeArabic(doctor.Specialty))
      ) {
        nextSession.Specialty = doctor.Specialty;
      }
    }


    if (!nextSession.Doctor && nextSession.Specialty) {
      const matches = findDoctorsBySpecialty(doctors, nextSession.Specialty);

      if (matches.length > 1) {
        await createOrUpdateSession(nextSession);

        return res.send(
          buildTwiml(
            "اختر الطبيب:\n" +
              matches.map((d, i) => `${i + 1}- ${d.Doctor}`).join("\n")
          )
        );
      }

      if (matches.length === 1) {
        nextSession.Doctor = matches[0].Doctor;
      }
    }


    if (nextSession.Doctor && nextSession.Time) {
      const doctor = findDoctorByName(doctors, nextSession.Doctor);

      if (
        doctor &&
        !isWithinDoctorHours(
          nextSession.Time,
          doctor.StartTime,
          doctor.EndTime
        )
      ) {
        nextSession.Time = "";

        await createOrUpdateSession(nextSession);

        return res.send(
          buildTwiml(
            `الوقت خارج دوام د. ${doctor.Doctor}`
          )
        );
      }
    }


    const ready =
      nextSession.Doctor &&
      nextSession.Specialty &&
      nextSession.Day &&
      nextSession.Time &&
      nextSession.Name;


    if (ready) {
      const bookings = await getBookings();

      const duplicate = bookings.find(
        (b) =>
          b.Doctor === nextSession.Doctor &&
          b.Day === nextSession.Day &&
          b.Time === nextSession.Time
      );

      if (duplicate) {
        return res.send(buildTwiml("هذا الموعد غير متاح."));
      }

      await saveBooking({
        user: userNumber,
        name: nextSession.Name,
        doctor: nextSession.Doctor,
        specialty: nextSession.Specialty,
        day: nextSession.Day,
        time: nextSession.Time
      });

      await clearSession(userNumber);

      return res.send(
        buildTwiml(
          `تم تأكيد الحجز ✅

الاسم: ${nextSession.Name}
الطبيب: ${nextSession.Doctor}
التخصص: ${nextSession.Specialty}
اليوم: ${nextSession.Day}
الوقت: ${nextSession.Time}`
        )
      );
    }


    await createOrUpdateSession(nextSession);


    if (!nextSession.Doctor)
      return res.send(
        buildTwiml("فضلاً اختر الطبيب أو التخصص.")
      );

    if (!nextSession.Day)
      return res.send(
        buildTwiml("ما اليوم المناسب لك؟")
      );

    if (!nextSession.Time)
      return res.send(
        buildTwiml("ما الوقت المناسب لك؟")
      );

    if (!nextSession.Name)
      return res.send(
        buildTwiml("ما اسمك الكامل؟")
      );


    return res.send(buildTwiml("كيف أساعدك؟"));
  } catch (error) {
    console.error(error);

    return res.send(
      buildTwiml("حدث خطأ مؤقت.")
    );
  }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server Running " + PORT);
});