const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET = 7 * HOUR;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 18;

const dayStart = local => local - (((local % DAY) + DAY) % DAY);
const isWeekday = local => {
  const d = new Date(local).getUTCDay();
  return d >= 1 && d <= 5;
};

function isWorking(ms) {
  const local = ms + OFFSET;
  const hour = new Date(local).getUTCHours();
  return isWeekday(local) && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

function nextOpen(local) {
  let day = dayStart(local);
  if (isWeekday(day) && local < day + OPEN_HOUR * HOUR) return day + OPEN_HOUR * HOUR;
  do {
    day += DAY;
  } while (!isWeekday(day));
  return day + OPEN_HOUR * HOUR;
}

function addWorkingMinutes(ms, minutes) {
  let local = ms + OFFSET;
  let remaining = minutes * MINUTE;
  if (!isWorking(ms)) local = nextOpen(local);
  while (true) {
    const close = dayStart(local) + CLOSE_HOUR * HOUR;
    const available = close - local;
    if (remaining <= available) return local + remaining - OFFSET;
    remaining -= available;
    local = nextOpen(close);
  }
}

function workingDayKey(ms) {
  return new Date(ms + OFFSET).toISOString().slice(0, 10);
}

module.exports = { isWorking, addWorkingMinutes, workingDayKey };
