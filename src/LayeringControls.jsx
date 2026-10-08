export function LayeringControls({ value, onChange, disabled = false }) {
  return (
    <fieldset className="layering-controls" disabled={disabled}>
      <legend>Ways to wear</legend>
      <label className="layering-checkbox">
        <input type="checkbox" checked={value.canLayer === true} onChange={(event) => onChange({ ...value, canLayer: event.target.checked, layeringSource: "manual" })} />
        <span>Can wear as a layer</span>
      </label>
      <p>Wear over a compatible inner piece, such as a T-shirt or hoodie.</p>
    </fieldset>
  );
}
