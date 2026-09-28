// Horario laboral — sirve para el timeout de toma del handoff.
//
// Por qué existe: si una consulta entra un sábado a las 23:40 y el reloj
// corriera en tiempo real, el lunes a la mañana ya habría rebotado por todos
// los vendedores del reparto. El reloj se pausa fuera del horario.
//
// Tucumán no tiene horario de verano, así que alcanza con un offset fijo
// (TZ_OFFSET_HORAS = -3) en vez de arrastrar una librería de zonas horarias.
import { config } from "../config.js";

const MS_POR_MINUTO = 60_000;
const MS_POR_HORA = 3_600_000;

function diasLaborales(): Set<number> {
  return new Set(
    config.LABORAL_DIAS.split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  );
}

/** La misma instante, corrido al huso local, para poder leerle día y hora. */
function aLocal(fecha: Date): Date {
  return new Date(fecha.getTime() + config.TZ_OFFSET_HORAS * MS_POR_HORA);
}

/**
 * Minutos de horario laboral transcurridos entre dos fechas. Devuelve 0 si
 * `hasta` es anterior a `desde`.
 */
export function minutosHabilesEntre(desde: Date, hasta: Date): number {
  if (hasta <= desde) return 0;

  const dias = diasLaborales();
  const { LABORAL_DESDE: apertura, LABORAL_HASTA: cierre } = config;
  // Config inválida (cierre antes de apertura): se degrada a tiempo real en
  // vez de devolver 0 para siempre, que dejaría handoffs colgados sin límite.
  if (cierre <= apertura || dias.size === 0) {
    return Math.floor((hasta.getTime() - desde.getTime()) / MS_POR_MINUTO);
  }

  const inicioLocal = aLocal(desde);
  const finLocal = aLocal(hasta);

  let total = 0;
  // Se recorre día por día desde la medianoche local del primero. El tope de
  // 400 vueltas evita un loop infinito si llegara una fecha absurda; con más
  // de un año de diferencia el handoff está vencido de todas formas.
  const cursor = new Date(inicioLocal);
  cursor.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < 400 && cursor <= finLocal; i++) {
    if (dias.has(cursor.getUTCDay())) {
      const abre = new Date(cursor);
      abre.setUTCHours(apertura, 0, 0, 0);
      const cierra = new Date(cursor);
      cierra.setUTCHours(cierre, 0, 0, 0);

      const arranca = Math.max(abre.getTime(), inicioLocal.getTime());
      const termina = Math.min(cierra.getTime(), finLocal.getTime());
      if (termina > arranca) total += (termina - arranca) / MS_POR_MINUTO;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.floor(total);
}

/** ¿Estamos dentro del horario de atención ahora mismo? */
export function esHorarioLaboral(fecha: Date = new Date()): boolean {
  const local = aLocal(fecha);
  const hora = local.getUTCHours();
  return (
    diasLaborales().has(local.getUTCDay()) &&
    hora >= config.LABORAL_DESDE &&
    hora < config.LABORAL_HASTA
  );
}
