/**
 * The glossary's fixed sentences in Spanish (M9-12; docs/glossary.md · Other exact sentences, and
 * the spec's vocabulary table): each is said one way on every staff screen. The test beside it
 * holds every catalog string that says the English sentence to this Spanish, word for word, and
 * every longer string that quotes it to quote this Spanish. The fluent reviewer signs these off
 * with the screens; a change goes here first, then into es.ts.
 */
export interface FixedSentence {
  readonly en: string;
  readonly es: string;
}

export const FIXED_SENTENCES: readonly FixedSentence[] = [
  { en: "Ask the room to wait", es: "Pedir a la sala que espere" },
  { en: "Charge the remaining tabs", es: "Cobrar las cuentas restantes" },
  { en: "Close the night", es: "Cerrar la noche" },
  {
    en: "Your bill is ready · ordering is closed",
    es: "Tu cuenta está lista · ya no se toman pedidos",
  },
  { en: "Declined · try another card or cash", es: "Rechazada · prueba otra tarjeta o efectivo" },
  {
    en: "Checking with Stripe · don't retry",
    es: "Consultando con Stripe · no lo intentes de nuevo",
  },
  { en: "Reader busy", es: "Lector ocupado" },
  { en: "Hold raise declined", es: "Aumento de retención rechazado" },
  { en: "Cut off by {name}", es: "Cortado por {name}" },
  {
    en: "Your server has paused alcohol for this room",
    es: "Tu mesero pausó el alcohol para esta sala",
  },
  {
    en: "Walk every room and the bar · no drinks left out",
    es: "Recorre cada sala y la barra · que no quede ninguna bebida",
  },
  { en: "Staff get it on their phones", es: "El personal lo recibe en sus teléfonos" },
  { en: "Not delivered · Call", es: "No entregado · Llamar" },
  { en: "Limit not set · Admin → Safety", es: "Aforo sin definir · Admin → Seguridad" },
  {
    en: "Song price · not set · songs need a drink credit",
    es: "Precio por canción · sin definir · las canciones necesitan un crédito de bebida",
  },
  { en: "TRAINING · not real money", es: "ENTRENAMIENTO · no es dinero real" },
  {
    en: "Room orders would have nowhere to ring. Turn off Ordering from the room too?",
    es: "Los pedidos de sala no tendrían dónde sonar. ¿Apagar también Pedidos desde la sala?",
  },
  {
    en: "On backup internet · card readers may take up to 2 min to switch",
    es: "Con internet de respaldo · los lectores de tarjetas pueden tardar hasta 2 min en cambiar",
  },
  {
    en: "Offline · read-only · orders queue with an offline code",
    es: "Sin conexión · solo lectura · los pedidos se ponen en cola con un código sin conexión",
  },
  {
    en: "Stripe is having trouble · card payments may fail",
    es: "Stripe tiene problemas · los pagos con tarjeta pueden fallar",
  },
  { en: "Texts are delayed", es: "Los mensajes de texto llegan con retraso" },
  { en: "Read to guest ✓", es: "Leído al cliente ✓" },
  { en: "Repeat round", es: "Repetir ronda" },
  { en: "Pay my share", es: "Pagar mi parte" },
];
