/**
 * How large an uploaded 3D model may be. One number, used everywhere.
 *
 * It lives in public/ because public/supabase.js imports it, and that file is
 * also loaded straight into a browser by scripts/check-session-refresh.mjs, so
 * it cannot reach into lib/.
 *
 * Three limits exist, and only the first is one an owner ever sees:
 *
 *   40 MB   MODEL_UPLOAD_LIMIT_BYTES — what the portal promises and enforces.
 *           Larger files are compressed in the browser to fit under it
 *           (app/portal/compress-model.js), and uploadModel() refuses
 *           anything still over it.
 *   50 MB   Supabase's per-file cap on a Free project, whatever the bucket
 *           says. The 10 MB of headroom is why 40 is not 50: a model that only
 *           just fits still costs every shopper that download on a phone.
 *   100 MB  The furniture-models bucket's own file_size_limit
 *           (supabase/migrations/0005_raise_model_limit.sql). Only reachable
 *           on a paid project, and never by this portal.
 *
 * Before this file the form compressed to 40 MB, uploadModel() checked 100 MB
 * and the error text quoted the bucket — three answers to one question.
 */
export const MODEL_UPLOAD_LIMIT_BYTES = 40 * 1024 * 1024;

/** "40 MB", for copy that has to state the limit. */
export const MODEL_UPLOAD_LIMIT_LABEL = `${MODEL_UPLOAD_LIMIT_BYTES / (1024 * 1024)} MB`;
