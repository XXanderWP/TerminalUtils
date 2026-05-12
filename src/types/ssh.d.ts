interface SSHServer {
  name: string;
  addr: string;
  password?: string;
}

interface SSHConfig {
  servers: SSHServer[];
}
