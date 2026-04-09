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

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "15-mvbqeRaJZsVD_eziUecqwRVmaiAjXb_SuoQ7kbQ24";

/* 
ملخص تنفيذي:
خادم Node.js/Express لإدارة حجز مواعيد واتساب باستخدام Google Sheets وOpenAI.
- يقرأ/يكتب بيانات من جداول Google Sheets (Doctors, Sessions, Bookings) بحسب الأعمدة المحددة.
- يستخدم OpenAI GPT-4o-mini لتحليل نص الرسالة واستخراج: Intent، طبيب، تخصص، يوم، وقت، اسم.
- يتابع الحوار عبر جلسة مستخدم مخزنة في جدول Sessions، ويملأ البيانات تدريجياً.
- يتحقق من النية والإجابة المناسبة، ويمنع تكرار/تعارض المواعيد قبل الحجز النهائي.
- يحتوي على سجلات تصحيحية (DEBUG) توضح كل خطوة (NEW MESSAGE, SESSION, FINAL_SESSION, ...).
- يرد دائماً بمحتوى TwiML XML (Content-Type text/xml).

متغيرات البيئة المطلوبة:
OPENAI_API_KEY, GOOGLE_CREDENTIALS (JSON), SPREADSHEET_ID (معرف الجدول).

الجداول المطلوبة والأعمدة:
| جدول        | الأعمدة بالترتيب                                                           |
|------------|-----------------------------------------------------------------------------|
| Doctors    | Doctor, Specialty, AvailableDays, StartTime, EndTime, Status                |
| Sessions   | User, Intent, Doctor, Specialty, Day, Time, Name, LastMessage, UpdatedAt    |
| Bookings   | BookingID, User, Name, Doctor, Specialty, Day, Time, Status, CreatedAt, Notes |
*/

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}
function normalizeArabic(text) {
  if (!text) return "";
  return text.toString().trim().toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ء/g, "")
    .replace(/ي/g, "ي");
}
function parseHour(value) {
  if (!value) return null;
  const match = String(value).trim().toLowerCase().match(/^(?:(\d{1,2})(?::(\d{2}))?)(?:\s*(am|pm))?$/);
  if (match) {
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    if (match[3] === "pm" && hour < 12) hour += 12;
    if (match[3] === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour + minute / 60;
    }
  }
  return null;
}
function isWithinDoctorHours(userTime, start, end) {
  const req = parseHour(userTime);
  const s = parseHour(start), e = parseHour(end);
  if (req === null || s === null || e === null) return true;
  return req >= s && req <= e;
}
function isDoctorAvailableOnDay(doctor, day) {
  if (!doctor || !doctor.AvailableDays || !day) return true;
  const map = {
    "السبت": "Sat", "الاحد": "Sun", "الاثنين": "Mon",
    "الثلاثاء": "Tue", "الاربعاء": "Wed", "الخميس": "Thu", "الجمعة": "Fri"
  };
  const d = normalizeArabic(day);
  let eng = "";
  for (const [ar, en] of Object.entries(map)) {
    if (d.includes(normalizeArabic(ar))) { eng = en; break; }
  }
  if (!eng) return true;
  const days = doctor.AvailableDays.toLowerCase().split(",").map(s => s.trim());
  return days.includes(eng.toLowerCase());
}
function formatDoctorsForPrompt(doctors) {
  return doctors.map(d => ({
    Doctor: d.Doctor, Specialty: d.Specialty,
    AvailableDays: d.AvailableDays, StartTime: d.StartTime, EndTime: d.EndTime, Status: d.Status
  }));
}
function formatDoctorsList(doctors) {
  if (!doctors || doctors.length === 0) {
    return "لا يوجد أطباء متاحون حالياً.";
  }
  return doctors.map((d,i) =>
    `${i+1}- د. ${d.Doctor} - ${d.Specialty} (${d.StartTime} إلى ${d.EndTime})`
  ).join("\n");
}
function generateBookingId() {
  return `BK-${Date.now()}`;
}
function buildTwiml(message) {
  const safe = String(message || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${safe}</Message>
</Response>`;
}

// Google Sheets helpers
async function getSheetRows(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}
async function getDoctors() {
  const rows = await getSheetRows("Doctors!A2:F");
  return rows.map((row, idx) => ({
    rowIndex: idx+2,
    Doctor: row[0]||"", Specialty: row[1]||"",
    AvailableDays: row[2]||"", StartTime: row[3]||"",
    EndTime: row[4]||"", Status: row[5]||""
  })).filter(d => d.Doctor);
}
async function getSessions() {
  const rows = await getSheetRows("Sessions!A2:I");
  return rows.map((row, idx) => ({
    rowIndex: idx+2,
    User: row[0]||"", Intent: row[1]||"",
    Doctor: row[2]||"", Specialty: row[3]||"",
    Day: row[4]||"", Time: row[5]||"",
    Name: row[6]||"", LastMessage: row[7]||"",
    UpdatedAt: row[8]||""
  }));
}
async function getSessionByUser(user) {
  const sessions = await getSessions();
  return sessions.find(s => s.User === user) || null;
}
async function createOrUpdateSession(data) {
  const existing = await getSessionByUser(data.User);
  const values = [[
    data.User||"", data.Intent||"", data.Doctor||"",
    data.Specialty||"", data.Day||"", data.Time||"",
    data.Name||"", data.LastMessage||"", new Date().toLocaleString("en-GB")
  ]];
  if (existing) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sessions!A${existing.rowIndex}:I${existing.rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    return existing.rowIndex;
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sessions!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    const after = await getSessionByUser(data.User);
    return after ? after.rowIndex : null;
  }
}
async function markSessionClosed(existing) {
  if (!existing) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sessions!B${existing.rowIndex}:B${existing.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["CLOSED"]] }
  });
}
async function getBookings() {
  const rows = await getSheetRows("Bookings!A2:J");
  return rows.map(row => ({
    BookingID: row[0]||"", User: row[1]||"",
    Name: row[2]||"", Doctor: row[3]||"",
    Specialty: row[4]||"", Day: row[5]||"",
    Time: row[6]||"", Status: row[7]||"",
    CreatedAt: row[8]||"", Notes: row[9]||""
  }));
}
async function saveBooking({ user, name, doctor, specialty, day, time, notes="" }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Bookings!A:J",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        generateBookingId(), user||"", name||"",
        doctor||"", specialty||"", day||"",
        time||"", "Confirmed",
        new Date().toLocaleString("en-GB"), notes||""
      ]]
    }
  });
}
function findDoctorByName(doctors, doctorName) {
  if (!doctorName) return null;
  const q = normalizeArabic(doctorName);
  return doctors.find(d => normalizeArabic(d.Doctor).includes(q));
}
function findDoctorsBySpecialty(doctors, specialty) {
  if (!specialty) return [];
  const q = normalizeArabic(specialty);
  return doctors.filter(d => normalizeArabic(d.Specialty).includes(q));
}
function isDoctorActive(doctor) {
  return doctor.Status && doctor.Status.toLowerCase() === "active";
}

// OpenAI Chat analysis
async function analyzeMessage({ message, session, doctors }) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: `
أنت موظف استقبال كريم في عيادة Sitmaai Clinic.
- مهمتك: إدارة حجز المواعيد والرد على استفسارات العملاء باحتراف وبالعربية.
- استخدم فقط بيانات الأطباء المتوفرة (Doctor, Specialty, AvailableDays, StartTime, EndTime, Status).
- إذا المعلومات ناقصة، اطلب المطلوب فقط بدون إعادة التفاصيل.
- إذا ذكر العميل تخصصًا (مثلاً "أسنان" أو "جلدية") بلاغة دون طبيب محدد، اعتبره بدء حجز.
- كن مختصرًا وواضحًا؛ لا تكرر نفسك.
ارجع JSON بالشكل:
{"intent":"booking|ask_doctors|ask_hours|cancel|normal","reply":"","doctor":"","specialty":"","day":"","time":"","name":"","booking_ready":false,"cancel_session":false,"notes":""}
قواعد:
1) intent="ask_doctors" لعرض قائمة الأطباء عند السؤال عنها.
2) intent="ask_hours" للاستفسار عن دوام.
3) intent="cancel" لإلغاء العملية.
4) intent="booking" لبدء حجز.
5) املأ doctor/specialty/day/time/name من النص.
6) booking_ready=true فقط إذا اكتملت (doctor أو specialty) + day + time + name.
بيانات الأطباء: ${JSON.stringify(formatDoctorsForPrompt(doctors))}
السياق: ${JSON.stringify(session)}
`},
      { role: "user", content: message }
    ]
  });

  let raw = completion.choices[0].message.content
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    return {
      intent: "normal",
      reply: "عذرًا، لم أفهم طلبك.",
      doctor: "", specialty: "", day: "", time: "", name: "",
      booking_ready: false, cancel_session: false, notes: ""
    };
  }
}

// WhatsApp webhook
app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = normalizeText(req.body.Body);
    const userNumber = String(req.body.From || "").replace("whatsapp:", "");
    console.log("NEW MESSAGE:", incomingMsg);

    if (!incomingMsg) {
      res.set("Content-Type", "text/xml");
      return res.status(200).send(buildTwiml("فضلاً أرسل رسالتك."));
    }

    const allDoctors = await getDoctors();
    const activeDoctors = allDoctors.filter(isDoctorActive);
    const existingSession = await getSessionByUser(userNumber);
    const session = existingSession || { User:userNumber, Intent:"", Doctor:"", Specialty:"", Day:"", Time:"", Name:"", LastMessage:"" };
    console.log("SESSION:", session);

    const aiResult = await analyzeMessage({ message: incomingMsg, session, doctors: activeDoctors });
    console.log("AI_RESULT:", aiResult);

    // إلغاء
    if (aiResult.cancel_session || aiResult.intent === "cancel") {
      if (existingSession) await markSessionClosed(existingSession);
      res.set("Content-Type", "text/xml");
      return res.status(200).send(buildTwiml("تم إلغاء العملية."));
    }

    // سؤال عن الأطباء
    if (aiResult.intent === "ask_doctors") {
      const list = formatDoctorsList(activeDoctors);
      res.set("Content-Type", "text/xml");
      return res.status(200).send(buildTwiml(`الأطباء:\n${list}`));
    }

    // سؤال عن الدوام
    if (aiResult.intent === "ask_hours") {
      if (aiResult.doctor) {
        const doc = findDoctorByName(activeDoctors, aiResult.doctor);
        if (doc) {
          res.set("Content-Type", "text/xml");
          return res.status(200).send(buildTwiml(`د. ${doc.Doctor}: ${doc.StartTime}-${doc.EndTime}`));
        }
      }
      if (aiResult.specialty) {
        const matches = findDoctorsBySpecialty(activeDoctors, aiResult.specialty);
        if (matches.length) {
          const text = matches.map(d => `د. ${d.Doctor}: ${d.StartTime}-${d.EndTime}`).join("\n");
          res.set("Content-Type", "text/xml");
          return res.status(200).send(buildTwiml(text));
        }
      }
      const allHours = activeDoctors.map(d => `د. ${d.Doctor}: ${d.StartTime}-${d.EndTime}`).join("\n");
      res.set("Content-Type", "text/xml");
      return res.status(200).send(buildTwiml(`ساعات العمل:\n${allHours}`));
    }

    // بناء الجلسة التالية بحفظ القيم السابقة
    const nextSession = {
      User: userNumber,
      Intent: "booking",
      Doctor: (aiResult.doctor && aiResult.doctor.trim() !== "") ? aiResult.doctor : (session.Doctor || ""),
      Specialty: (aiResult.specialty && aiResult.specialty.trim() !== "") ? aiResult.specialty : (session.Specialty || ""),
      Day: (aiResult.day && aiResult.day.trim() !== "") ? aiResult.day : (session.Day || ""),
      Time: (aiResult.time && aiResult.time.trim() !== "") ? aiResult.time : (session.Time || ""),
      Name: (aiResult.name && aiResult.name.trim() !== "") ? aiResult.name : (session.Name || ""),
      LastMessage: incomingMsg
    };
    console.log("FINAL_SESSION:", nextSession);

    // إذا ذكر تخصص فقط
    if (!nextSession.Doctor && nextSession.Specialty) {
      const matches = findDoctorsBySpecialty(activeDoctors, nextSession.Specialty);
      if (!matches.length) {
        await createOrUpdateSession(nextSession);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml("لا يوجد طبيب لهذا التخصص."));
      }
      if (matches.length === 1) {
        nextSession.Doctor = matches[0].Doctor;
        nextSession.Specialty = matches[0].Specialty;
      } else {
        await createOrUpdateSession(nextSession);
        const opts = matches.map((d,i) => `${i+1}- د. ${d.Doctor}`).join("\n");
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml(`اختر الطبيب:\n${opts}`));
      }
    }

    // تحقق من الطبيب
    if (nextSession.Doctor) {
      const docObj = findDoctorByName(activeDoctors, nextSession.Doctor);
      if (!docObj) {
        await createOrUpdateSession(nextSession);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml("اسم الطبيب غير واضح."));
      }
      nextSession.Doctor = docObj.Doctor;
      nextSession.Specialty = docObj.Specialty || nextSession.Specialty;
    }

    // تحقق من اليوم
    if (nextSession.Doctor && nextSession.Day) {
      const docObj = findDoctorByName(activeDoctors, nextSession.Doctor);
      if (docObj && !isDoctorAvailableOnDay(docObj, nextSession.Day)) {
        nextSession.Day = "";
        await createOrUpdateSession(nextSession);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml(`د. ${docObj.Doctor} ليس متاحاً في هذا اليوم.`));
      }
    }

    // تحقق من الوقت
    if (nextSession.Doctor && nextSession.Time) {
      const docObj = findDoctorByName(activeDoctors, nextSession.Doctor);
      if (docObj && !isWithinDoctorHours(nextSession.Time, docObj.StartTime, docObj.EndTime)) {
        nextSession.Time = "";
        await createOrUpdateSession(nextSession);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml(`الوقت خارج دوام د. ${docObj.Doctor}.`));
      }
    }

    const ready = nextSession.Doctor && nextSession.Specialty && nextSession.Day && nextSession.Time && nextSession.Name;
    console.log("READY_STATUS:", ready);

    if (ready) {
      const allBookings = await getBookings();
      const duplicate = allBookings.find(b =>
        b.User === userNumber && b.Doctor === nextSession.Doctor &&
        b.Day === nextSession.Day && b.Time === nextSession.Time
      );
      if (duplicate) {
        console.log("DUPLICATE_FOUND:", duplicate);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml("هذا الموعد محجوز لك مسبقاً."));
      }
      const conflict = allBookings.find(b =>
        b.Doctor === nextSession.Doctor && b.Day === nextSession.Day && b.Time === nextSession.Time
      );
      if (conflict) {
        console.log("CONFLICT_FOUND:", conflict);
        res.set("Content-Type", "text/xml");
        return res.status(200).send(buildTwiml("هذا الوقت غير متاح."));
      }
      await saveBooking({
        user: userNumber,
        name: nextSession.Name,
        doctor: nextSession.Doctor,
        specialty: nextSession.Specialty,
        day: nextSession.Day,
        time: nextSession.Time,
        notes: aiResult.notes || ""
      });
      console.log("BOOKING_SAVED:", nextSession);
      if (existingSession) {
        await markSessionClosed(existingSession);
      }
      res.set("Content-Type", "text/xml");
      return res.status(200).send(buildTwiml(
        `تم تأكيد حجزك:\n` +
        `الاسم: ${nextSession.Name}\n` +
        `الطبيب: د. ${nextSession.Doctor}\n` +
        `التخصص: ${nextSession.Specialty}\n` +
        `اليوم: ${nextSession.Day}\n` +
        `الوقت: ${nextSession.Time}`
      ));
    }

    await createOrUpdateSession(nextSession);
    let reply = aiResult.reply;
    if (!nextSession.Doctor && !nextSession.Specialty) {
      reply = `الأطباء المتاحون:\n${formatDoctorsList(activeDoctors)}`;
    } else if (!nextSession.Day) {
      reply = `د. ${nextSession.Doctor} (${nextSession.Specialty}) تم اختيار. أي يوم؟`;
    } else if (!nextSession.Time) {
      reply = "أي وقت يناسبك؟";
    } else if (!nextSession.Name) {
      reply = "ما اسمك الكامل؟";
    }
    res.set("Content-Type", "text/xml");
    return res.status(200).send(buildTwiml(reply));

  } catch (error) {
    console.error("WHATSAPP_ERROR:", error);
    res.set("Content-Type", "text/xml");
    return res.status(200).send(buildTwiml("عذراً، حدث خطأ."));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});