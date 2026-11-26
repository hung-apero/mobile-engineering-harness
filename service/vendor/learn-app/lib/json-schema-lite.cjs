function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  return [].concat(expected).some(t => t === actual || (t === 'number' && actual === 'integer'));
}

function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.type && !typeMatches(value, schema.type)) return [`${at}: cần ${[].concat(schema.type).join('|')}, gặp ${typeOf(value)}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: giá trị ${JSON.stringify(value)} không thuộc ${schema.enum.join('|')}`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: thiếu ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(sub, value[key], `${at}.${key}`));
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${at}[${index}]`)));
  return errors;
}

module.exports = { validate };
