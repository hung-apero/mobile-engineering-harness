for (const name of Object.keys(process.env)) if (/WEBHOOK/i.test(name)) delete process.env[name];
