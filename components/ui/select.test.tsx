import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function SeletorDeFuso() {
  const [fuso, setFuso] = useState("America/Sao_Paulo");
  return (
    <form>
      <Select name="timezone" value={fuso} onValueChange={setFuso}>
        <SelectTrigger aria-label="Fuso">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="America/Sao_Paulo">São Paulo</SelectItem>
          <SelectItem value="America/Los_Angeles">Los Angeles</SelectItem>
        </SelectContent>
      </Select>
    </form>
  );
}

describe("Select — tradução do navegador", () => {
  it.each([false, true])(
    "troca a opção sem perder o formulário quando o navegador traduz o texto: %s",
    async (traduzir) => {
      const user = userEvent.setup();
      const { container } = render(<SeletorDeFuso />);
      const gatilho = screen.getByRole("combobox", { name: "Fuso" });
      expect(gatilho).toHaveTextContent("São Paulo");

      await user.click(gatilho);
      if (traduzir) {
        const walker = document.createTreeWalker(gatilho, NodeFilter.SHOW_TEXT);
        const texto = walker.nextNode();
        if (!texto?.parentNode) throw new Error("O gatilho não tem texto para traduzir");
        const traduzido = document.createElement("font");
        traduzido.textContent = "Sao Paulo";
        texto.parentNode.replaceChild(traduzido, texto);
      }
      await user.click(screen.getByRole("option", { name: "Los Angeles" }));

      expect(gatilho).toHaveTextContent("Los Angeles");
      const formulario = container.querySelector("form");
      if (!formulario) throw new Error("O formulário desapareceu");
      expect(new FormData(formulario).get("timezone")).toBe("America/Los_Angeles");

      await user.click(gatilho);
      await user.click(screen.getByRole("option", { name: "São Paulo" }));
      expect(gatilho).toHaveTextContent("São Paulo");
      expect(new FormData(formulario).get("timezone")).toBe("America/Sao_Paulo");
    },
  );
});
