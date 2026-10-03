/** An error with the HTTP status the API answers with. */
export const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
