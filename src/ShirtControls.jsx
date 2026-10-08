export function ShirtControls({ value, onChange, disabled = false }) {
  if (value.part !== "upperbody") return null;
  return (
    <fieldset className="shirt-controls" disabled={disabled}>
      <legend>Ways to wear</legend>
      <label className="shirt-checkbox">
        <input type="checkbox" checked={value.isShirt === true} onChange={(event) => onChange({ ...value, isShirt: event.target.checked, canLayer: event.target.checked && value.canLayer === true, layeringSource: "manual" })} />
        <span>This is a shirt</span>
      </label>
      {value.isShirt && <>
        <label className="shirt-checkbox">
          <input type="checkbox" checked={value.canLayer === true} onChange={(event) => onChange({ ...value, canLayer: event.target.checked, layeringSource: "manual" })} />
          <span>Can wear as a layer</span>
        </label>
        <p>{value.canLayer ? "Create looks closed as a top and open over an inner top." : "For casual shirts such as flannels and overshirts."}</p>
      </>}
    </fieldset>
  );
}
