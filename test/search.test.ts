import { describe, expect, it } from "vitest";
import { parseSearchQuery, palabrasWhere } from "../src/lib/search.js";

// Parser del buscador natural (#8). Es una función pura: no necesita BD.
describe("parseSearchQuery", () => {
  it("extrae el tipo por sinónimo y deja el resto como texto", () => {
    const r = parseSearchQuery("monoambiente en barrio sur");
    expect(r.tipo).toBe("monoambiente");
    expect(r.dormitorios).toBeUndefined();
    // "en" y "barrio" son stopwords; queda la palabra distintiva.
    expect(r.palabras).toEqual(["sur"]);
  });

  it("extrae tipo (abreviatura) y dormitorios", () => {
    const r = parseSearchQuery("depto 2 dormitorios centro");
    expect(r.tipo).toBe("departamento");
    expect(r.dormitorios).toBe(2);
    expect(r.palabras).toEqual(["centro"]);
  });

  it("tolera acentos en el tipo (dúplex ≈ duplex)", () => {
    expect(parseSearchQuery("dúplex").tipo).toBe("duplex");
    expect(parseSearchQuery("duplex").tipo).toBe("duplex");
  });

  it("reconoce 'local comercial' como frase", () => {
    expect(parseSearchQuery("local comercial en el centro").tipo).toBe("local_comercial");
  });

  it("sin tipo ni dormitorios, todo va a texto (sin stopwords)", () => {
    const r = parseSearchQuery("casa con patio y parrilla");
    expect(r.tipo).toBe("casa");
    expect(r.dormitorios).toBeUndefined();
    expect(r.palabras).toEqual(["patio", "parrilla"]);
  });

  it("query vacía devuelve sin filtros", () => {
    expect(parseSearchQuery("   ")).toEqual({ palabras: [] });
  });
});

describe("palabrasWhere", () => {
  it("sin palabras no agrega condición", () => {
    expect(palabrasWhere([])).toEqual({});
  });

  it("cada palabra debe aparecer en alguna columna (AND de palabras)", () => {
    const w = palabrasWhere(["sur", "luminoso"]);
    expect(Array.isArray(w.AND)).toBe(true);
    expect((w.AND as unknown[]).length).toBe(2);
  });
});
