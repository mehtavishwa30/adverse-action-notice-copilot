import type { Institution } from "./types.js";

/**
 * Fictional creditor used throughout the demo. The regulator block mirrors the
 * real FDIC consumer-response address, because that is the kind of detail that
 * must survive a prompt edit verbatim.
 */
export const INSTITUTION: Institution = {
  name: "Northwind Lending, N.A.",
  address: "1 Harbor Plaza, Boston, MA 02110",
  regulator: {
    name: "Federal Deposit Insurance Corporation, Consumer Response Center",
    address: "1100 Walnut Street, Box #11, Kansas City, MO 64106",
  },
};
