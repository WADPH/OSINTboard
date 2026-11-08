import { memo, useState } from 'react';

/**
 * User-defined fields on any node: a list of { id, name, value } stored in
 * node.data.fields. E.g. "Second name", "Fake name" on a Person node.
 */

let fieldCounter = 0;
const newFieldId = () =>
  `field_${Date.now().toString(36)}_${(++fieldCounter).toString(36)}`;

// Name suggestions offered in the name input (any name can still be typed)
const COMMON = ['Source', 'Confidence', 'First seen', 'Last seen', 'Notes'];
const SUGGESTIONS = {
  person: ['Second name', 'Alias / Fake name', 'Date of birth', 'Nationality', 'Occupation'],
  phone: ['Carrier', 'Country', 'Owner', 'Messengers'],
  email: ['Provider', 'Owner', 'Breaches', 'Linked accounts'],
  username: ['Platform', 'Profile URL', 'Display name'],
  social: ['Platform', 'Profile URL', 'Followers'],
  company: ['Registration no.', 'Country', 'Director', 'Website'],
  ip: ['ASN', 'ISP', 'Geo', 'Open ports'],
  address: ['City', 'Country', 'Postal code'],
};

export const CustomFieldsEditor = memo(
  ({ nodeId, nodeType, fields, onChange, onKeyDown }) => {
    const [focusId, setFocusId] = useState(null);
    const listId = `custom-field-names-${nodeId}`;
    const suggestions = [...(SUGGESTIONS[nodeType] || []), ...COMMON];

    const update = (id, patch) =>
      onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

    const add = () => {
      const id = newFieldId();
      onChange([...fields, { id, name: '', value: '' }]);
      setFocusId(id);
    };

    return (
      <div className="custom-fields-editor nodrag">
        {fields.map((f) => (
          <div key={f.id} className="custom-field-edit">
            <div className="custom-field-edit-head">
              <input
                className="osint-node-input custom-field-name-input"
                value={f.name}
                list={listId}
                placeholder="Field name…"
                autoFocus={focusId === f.id}
                onChange={(e) => update(f.id, { name: e.target.value })}
                onKeyDown={onKeyDown}
              />
              <button
                type="button"
                // Out of the tab order so Tab goes name → value
                tabIndex={-1}
                className="custom-field-remove"
                title="Remove field"
                onClick={() => onChange(fields.filter((x) => x.id !== f.id))}
              >
                ✕
              </button>
            </div>
            <input
              className="osint-node-input custom-field-value-input"
              value={f.value}
              placeholder="Value…"
              onChange={(e) => update(f.id, { value: e.target.value })}
              onKeyDown={onKeyDown}
            />
          </div>
        ))}
        <button type="button" className="custom-fields-add-btn" onClick={add}>
          + Add field
        </button>
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
    );
  }
);
CustomFieldsEditor.displayName = 'CustomFieldsEditor';

export const CustomFieldsView = memo(({ fields }) => {
  if (!fields || fields.length === 0) return null;
  return (
    <dl className="custom-fields-view">
      {fields.map((f) => (
        <div key={f.id} className="custom-field-row" title={`${f.name}: ${f.value}`}>
          <dt>{f.name || 'Field'}</dt>
          <dd>{f.value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
});
CustomFieldsView.displayName = 'CustomFieldsView';
