import { describe, expect, it } from "vitest";
import { onlyPackFields, readIdBarcode } from "./id-scan.js";

// Sample barcodes in the AAMVA layout (made up, never a real person's).
const NY = [
  "@",
  "\u001e",
  "ANSI 636001090002DL00410278ZN03190008DLDAQ123456789",
  "DCSRIVERA",
  "DACDIEGO",
  "DADMIGUEL",
  "DBB04121994",
  "DBA04122030",
  "DAG186 W 4TH ST",
  "DAINEW YORK",
  "DAJNY",
  "DAK100140000",
  "DAU069 IN",
  "DAYBRO",
  "DCGUSA",
].join("\n");

const ON = [
  "@",
  "ANSI 636012090001DL00310224DLDAQP1234-56789-01234",
  "DCSNGUYEN",
  "DACLINH",
  "DBB19990315",
  "DBA20280315",
  "DAG1 QUEEN ST",
  "DCGCAN",
].join("\n");

describe("reading an ID barcode on the device", () => {
  it("keeps only the four fields from a New York licence: name, date of birth, ID number, expiration", () => {
    const fields = readIdBarcode(NY);
    expect(fields).toEqual({
      name: "Diego Rivera",
      dateOfBirth: "1994-04-12",
      idNumber: "123456789",
      expiration: "2030-04-12",
    });
    expect(Object.keys(fields!)).toHaveLength(4);
    expect(JSON.stringify(fields)).not.toMatch(/186 W 4TH|NEW YORK|100140000|BRO|069/);
  });

  it("reads a Canadian licence's year-first dates", () => {
    expect(readIdBarcode(ON)).toEqual({
      name: "Linh Nguyen",
      dateOfBirth: "1999-03-15",
      idNumber: "P1234-56789-01234",
      expiration: "2028-03-15",
    });
  });

  it("refuses anything that isn't an ID barcode, or one missing a field", () => {
    expect(readIdBarcode("https://example.com")).toBeNull();
    expect(readIdBarcode(NY.replace("DBB04121994", ""))).toBeNull();
    expect(readIdBarcode(NY.replace("DBB04121994", "DBB13401994"))).toBeNull();
  });

  it("the server keeps only the rule pack's fields, whatever else arrives", () => {
    expect(
      onlyPackFields(
        {
          name: "Diego Rivera",
          dateOfBirth: "1994-04-12",
          idNumber: "123456789",
          expiration: "2030-04-12",
          address: "186 W 4th St",
          eyes: "BRO",
        },
        ["name", "dateOfBirth", "idNumber", "expiration"],
      ),
    ).toEqual({
      name: "Diego Rivera",
      dateOfBirth: "1994-04-12",
      idNumber: "123456789",
      expiration: "2030-04-12",
    });
  });
});
