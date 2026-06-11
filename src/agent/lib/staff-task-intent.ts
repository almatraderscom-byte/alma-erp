/** Detect when owner wants staff task planning (not generic chat). */
export function isStaffTaskPlanningInquiry(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /staff|stuff|স্টাফ|স্টাফ্|কর্মী|টিম/i.test(t) &&
    /task|টাস্ক|কাজ|কাজগুলো|কি হবে|দাও|দিব|প্ল্যান|plan/i.test(t)
  ) || (
    /eyafi|mustahid|ইয়াফি|মুস্তাহিদ/i.test(t) &&
    /task|টাস্ক|কাজ/i.test(t)
  ) || (
    /আজকে.*(কাজ|টাস্ক)|কাজ.*(কি|কী)|টাস্ক.*(কি|কী|প্ল্যান)|task.*(today|plan)/i.test(t)
  ) || (
    /কাজ.*(দাও|দিব|বানাও|পাঠাও|approve|অ্যাসাইন)/i.test(t)
  )
}
