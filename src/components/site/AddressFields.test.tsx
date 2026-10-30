import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddressFields } from "./AddressFields";
import { EMPTY_AU_ADDRESS, auAddressFieldId } from "@/lib/au-address";

describe("AddressFields", () => {
  it("asks for the four parts, each tied to its label", () => {
    render(<AddressFields idPrefix="address" value={EMPTY_AU_ADDRESS} onChange={() => {}} />);
    for (const label of ["Street address", "Suburb", "State", "Postcode"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Street address")).toHaveAttribute("id", "address_street");
  });

  it("reports what was typed as a whole draft", () => {
    const onChange = vi.fn();
    render(<AddressFields idPrefix="address" value={EMPTY_AU_ADDRESS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VIC" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_AU_ADDRESS, state: "VIC" });
    fireEvent.change(screen.getByLabelText("Postcode"), { target: { value: "3000" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_AU_ADDRESS, postcode: "3000" });
  });

  it("offers all eight states and lets the field stand empty", () => {
    render(<AddressFields idPrefix="address" value={EMPTY_AU_ADDRESS} onChange={() => {}} />);
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
        value={EMPTY_AU_ADDRESS}
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
        value={EMPTY_AU_ADDRESS}
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
        value={EMPTY_AU_ADDRESS}
        onChange={() => {}}
        fieldProps={(field) => (field === id ? { "aria-invalid": true } : {})}
        fieldMessage={(field) => (field === id ? <p>A postcode is four digits.</p> : null)}
      />,
    );
    expect(screen.getByLabelText("Postcode")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("A postcode is four digits.")).toBeInTheDocument();
  });
});
