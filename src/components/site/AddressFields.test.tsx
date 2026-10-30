import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddressFields } from "./AddressFields";
import { EMPTY_ADDRESS, auAddressFieldId } from "@/lib/au-address";

describe("AddressFields", () => {
  it("asks for the four parts, each tied to its label", () => {
    render(<AddressFields idPrefix="address" value={EMPTY_ADDRESS} onChange={() => {}} />);
    for (const label of ["Street address", "Suburb", "State", "Postcode"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Street address")).toHaveAttribute("id", "address_street");
  });

  it("reports what was typed as a whole draft", () => {
    const onChange = vi.fn();
    render(<AddressFields idPrefix="address" value={EMPTY_ADDRESS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VIC" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_ADDRESS, state: "VIC" });
    fireEvent.change(screen.getByLabelText("Postcode"), { target: { value: "3000" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_ADDRESS, postcode: "3000" });
  });

  it("offers all eight states and lets the field stand empty", () => {
    render(<AddressFields idPrefix="address" value={EMPTY_ADDRESS} onChange={() => {}} />);
    const options = Array.from(
      (screen.getByLabelText("State") as HTMLSelectElement).options,
      (o) => o.value,
    );
    expect(options).toEqual(["", "ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]);
  });

  it("gives a second address on the page its own autofill section", () => {
    render(
      <AddressFields
        idPrefix="guardian_address"
        section="guardian"
        value={EMPTY_ADDRESS}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("Postcode")).toHaveAttribute(
      "autocomplete",
      "section-guardian postal-code",
    );
  });

  it("shows an address held as one line, so nobody has to remember it", () => {
    render(
      <AddressFields
        idPrefix="address"
        value={EMPTY_ADDRESS}
        onChange={() => {}}
        previousLine="1 Broadway Ultimo"
      />,
    );
    expect(screen.getByText(/1 Broadway Ultimo/)).toBeInTheDocument();
  });

  it("lets the form flag a part and say why under it", () => {
    const id = auAddressFieldId("address", "postcode");
    render(
      <AddressFields
        idPrefix="address"
        value={EMPTY_ADDRESS}
        onChange={() => {}}
        fieldProps={(field) => (field === id ? { "aria-invalid": true } : {})}
        fieldMessage={(field) => (field === id ? <p>A postcode is four digits.</p> : null)}
      />,
    );
    expect(screen.getByLabelText("Postcode")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("A postcode is four digits.")).toBeInTheDocument();
  });

  it("asks about a postcode that does not usually go with the state, without blocking", () => {
    render(
      <AddressFields
        idPrefix="address"
        value={{ street: "1 Broadway", suburb: "Ultimo", state: "VIC", postcode: "2007" }}
        onChange={() => {}}
        showProblems
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/usually in NSW, not VIC/);
    // A note, not an error: nothing is marked invalid.
    expect(screen.getByLabelText("Postcode")).not.toHaveAttribute("aria-invalid");
  });

  it("holds the note back while the postcode itself is wrong", () => {
    render(
      <AddressFields
        idPrefix="address"
        value={{ street: "1 Broadway", suburb: "Ultimo", state: "VIC", postcode: "20x7" }}
        onChange={() => {}}
        showProblems
      />,
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  describe("outside Australia", () => {
    it("turns the boxes into free text, with a country, when ticked", () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <AddressFields idPrefix="address" value={EMPTY_ADDRESS} onChange={onChange} />,
      );
      expect(screen.queryByLabelText(/Country/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("This address is outside Australia"));
      expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_ADDRESS, overseas: true });

      rerender(
        <AddressFields
          idPrefix="address"
          value={{ ...EMPTY_ADDRESS, overseas: true }}
          onChange={onChange}
        />,
      );
      expect(screen.getByLabelText(/Country/)).toBeInTheDocument();
      // A typed box, not the list of Australian states.
      expect(screen.getByLabelText(/State or region/).tagName).toBe("INPUT");
      expect(screen.getByLabelText(/Postcode/)).not.toHaveAttribute("inputmode");
      expect(screen.getByLabelText(/Postcode/)).toHaveAttribute("maxlength", "12");
      // Everything but the street line says it is optional.
      expect(screen.getByText(/Town or city/).parentElement).toHaveTextContent("(optional)");
      expect(screen.getByLabelText("Street address")).toBeInTheDocument();
    });

    it("starts the street box from a line the club could not split", () => {
      const onChange = vi.fn();
      render(
        <AddressFields
          idPrefix="address"
          value={EMPTY_ADDRESS}
          onChange={onChange}
          previousLine="10 Downing St London"
        />,
      );
      fireEvent.click(screen.getByLabelText("This address is outside Australia"));
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ overseas: true, street: "10 Downing St London" }),
      );
    });

    it("drops an Australian state on the way over, and a typed region on the way back", () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <AddressFields
          idPrefix="address"
          value={{ ...EMPTY_ADDRESS, state: "NSW" }}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByLabelText("This address is outside Australia"));
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "" }));

      rerender(
        <AddressFields
          idPrefix="address"
          value={{ ...EMPTY_ADDRESS, overseas: true, state: "Bavaria" }}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByLabelText("This address is outside Australia"));
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ overseas: false, state: "" }),
      );
    });
  });
});
