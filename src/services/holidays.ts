type Country = "FR" | "QC" | "ES";

interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

// Easter calculation (Anonymous Gregorian algorithm)
function easterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// If a holiday falls on weekend, move to Monday
function adjustWeekend(date: Date): Date {
  const day = date.getDay();
  if (day === 0) return addDays(date, 1); // Sunday -> Monday
  if (day === 6) return addDays(date, 2); // Saturday -> Monday
  return date;
}

function franceholidays(year: number): Holiday[] {
  const easter = easterDate(year);
  const easterMonday = addDays(easter, 1);
  const ascension = addDays(easter, 39);
  const whitMonday = addDays(easter, 50);

  return [
    { date: `${year}-01-01`, name: "Jour de l'an" },
    { date: `${year}-01-02`, name: "Lendemain du Jour de l'an" },
    { date: fmt(easterMonday), name: "Lundi de Paques" },
    { date: `${year}-05-01`, name: "Fete du travail" },
    { date: `${year}-05-08`, name: "Fete de la victoire" },
    { date: fmt(ascension), name: "Ascension" },
    { date: fmt(whitMonday), name: "Lundi de Pentecote" },
    { date: `${year}-07-14`, name: "Fete nationale" },
    { date: `${year}-08-15`, name: "Assomption" },
    { date: `${year}-11-01`, name: "Toussaint" },
    { date: `${year}-11-11`, name: "Jour du souvenir" },
    { date: `${year}-12-25`, name: "Noel" },
    { date: `${year}-12-26`, name: "Lendemain de Noel" },
  ];
}

function quebecHolidays(year: number): Holiday[] {
  const easter = easterDate(year);
  const easterMonday = addDays(easter, 1);

  // Victoria Day: Monday before May 25
  const may25 = new Date(year, 4, 25);
  const victoriaDay = addDays(may25, -((may25.getDay() + 6) % 7));

  // St-Jean: June 24 (moved if weekend)
  const stJean = adjustWeekend(new Date(year, 5, 24));

  // Canada Day: July 1 (moved if weekend)
  const canadaDay = adjustWeekend(new Date(year, 6, 1));

  // Labour Day: 1st Monday of September
  const sept1 = new Date(year, 8, 1);
  const labourDay = addDays(sept1, (8 - sept1.getDay()) % 7);

  // Thanksgiving: 2nd Monday of October
  const oct1 = new Date(year, 9, 1);
  const firstMonOct = addDays(oct1, (8 - oct1.getDay()) % 7);
  const thanksgiving = addDays(firstMonOct, 7);

  return [
    { date: `${year}-01-01`, name: "Jour de l'An" },
    { date: fmt(easterMonday), name: "Lundi de Paques" },
    { date: fmt(victoriaDay), name: "Journee nationale des patriotes" },
    { date: fmt(stJean), name: "Fete nationale du Quebec" },
    { date: fmt(canadaDay), name: "Fete du Canada" },
    { date: fmt(labourDay), name: "Fete du Travail" },
    { date: fmt(thanksgiving), name: "Action de graces" },
    { date: `${year}-12-25`, name: "Noel" },
    // + 2 extra days for De Marque holiday period
    { date: `${year}-12-26`, name: "Conge De Marque" },
    { date: `${year}-12-27`, name: "Conge De Marque" },
  ];
}

function spainHolidays(year: number): Holiday[] {
  const easter = easterDate(year);
  const goodFriday = addDays(easter, -2);
  const easterMonday = addDays(easter, 1);
  const secondEaster = addDays(easter, 49); // 7th Monday after Easter

  return [
    { date: `${year}-01-01`, name: "Ano Nuevo" },
    { date: `${year}-01-06`, name: "Reyes Magos" },
    { date: fmt(goodFriday), name: "Viernes Santo" },
    { date: fmt(easterMonday), name: "Lunes de Pascua" },
    { date: `${year}-05-01`, name: "Dia del Trabajo" },
    { date: fmt(secondEaster), name: "Segunda Pascua" },
    { date: `${year}-06-24`, name: "Sant Joan" },
    { date: `${year}-08-15`, name: "Asuncion" },
    { date: `${year}-09-11`, name: "Diada de Catalunya" },
    { date: `${year}-09-24`, name: "La Merce" },
    { date: `${year}-10-12`, name: "Fiesta Nacional" },
    { date: `${year}-11-01`, name: "Todos los Santos" },
    { date: `${year}-12-06`, name: "Dia de la Constitucion" },
    { date: `${year}-12-08`, name: "Inmaculada Concepcion" },
    { date: `${year}-12-25`, name: "Navidad" },
    { date: `${year}-12-26`, name: "San Esteban" },
  ];
}

export function getHolidays(country: Country, year: number): Holiday[] {
  switch (country) {
    case "FR":
      return franceholidays(year);
    case "QC":
      return quebecHolidays(year);
    case "ES":
      return spainHolidays(year);
  }
}

export function isHoliday(
  country: Country,
  date: string
): { holiday: boolean; name?: string } {
  const year = parseInt(date.slice(0, 4));
  const holidays = getHolidays(country, year);
  const found = holidays.find((h) => h.date === date);
  return found ? { holiday: true, name: found.name } : { holiday: false };
}
