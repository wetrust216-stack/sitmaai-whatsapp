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

const SPREADSHEET_ID = "15-mvbqeRaJZsVD_eziUecqwRVmaiAjXb_SuoQ7kbQ24";

let bookingData = {};

app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body;
  const userNumber = req.body.From;

  let reply = "";

  if (!bookingData[userNumber]) {
    bookingData[userNumber] = {
      activeBooking: false,
      step: 0,
      data: {}
    };
  }

  const userState = bookingData[userNumber];

  if (
    incomingMsg.includes("حجز") ||
    incomingMsg.includes("موعد")
  ) {
    userState.activeBooking = true;
    userState.step = 1;
    reply = "ممتاز، ما نوع الخدمة المطلوبة؟";
  }

  else if (userState.activeBooking) {

    if (userState.step === 1) {
      userState.data.service = incomingMsg;
      userState.step++;
      reply = "ما اليوم المناسب لك؟";
    }

    else if (userState.step === 2) {
      userState.data.day = incomingMsg;
      userState.step++;
      reply = "ما الوقت المناسب لك؟";
    }

    else if (userState.step === 3) {
      userState.data.time = incomingMsg;
      userState.step++;
      reply = "ما اسمك الكامل؟";
    }

    else if (userState.step === 4) {
      userState.data.name = incomingMsg;
      userState.step++;
      reply = "ما رقم جوالك؟";
    }

    else if (userState.step === 5) {
      userState.data.phone = incomingMsg;

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "Sheet1!A:F",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            userState.data.name,
            userState.data.phone,
            userState.data.service,
            userState.data.day,
            userState.data.time,
            new Date().toLocaleString()
          ]]
        }
      });

      reply = "تم تأكيد حجزك بنجاح. شكراً لك.";
      delete bookingData[userNumber];
    }

  }

  else {

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
أنت موظف استقبال احترافي لعيادة طبية باسم Sitmaai Clinic.

مهامك:
- الرد على العملاء باحترافية.
- الإجابة عن استفسارات العيادة.
- توجيه العميل للحجز عند الحاجة.

قواعد:
- تكلم دائمًا بالعربية.
- كن مختصرًا وواضحًا.
- كن احترافيًا ولبقًا.
`
        },
        {
          role: "user",
          content: incomingMsg
        }
      ]
    });

    reply = aiResponse.choices[0].message.content;

  }

  res.set("Content-Type", "text/xml");

  res.send(`
<Response>
<Message>${reply}</Message>
</Response>
`);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running...");
});