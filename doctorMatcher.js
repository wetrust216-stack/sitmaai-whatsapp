function normalizeArabic(text) {
  return text
    ?.toString()
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

function findDoctor(doctors, input) {
  const normalizedInput = normalizeArabic(input);

  return doctors.find(doc => {
    const doctorName = normalizeArabic(doc.name);
    const specialty = normalizeArabic(doc.specialty);

    return (
      doctorName.includes(normalizedInput) ||
      specialty.includes(normalizedInput)
    );
  });
}

module.exports = findDoctor;