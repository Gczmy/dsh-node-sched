const TRANSIENT_SSH_ERROR = /connection timed out|operation timed out|connection refused|connection reset by peer|connection closed by remote host|no route to host|network is unreachable|kex_exchange|econnreset|econnrefused|etimedout|ehostunreach|enetunreach|timed out while waiting for handshake|connection lost before handshake|handshake failed|unable to connect|channel open failure/i;

export function isTransientSshError(text) {
	return TRANSIENT_SSH_ERROR.test(String(text ?? ""));
}
