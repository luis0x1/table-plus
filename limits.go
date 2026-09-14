package main

const (
	maxResultCellBytes         = 16 << 20
	maxResultBytes             = 64 << 20
	maxTransferSourceBytes     = 512 << 20
	maxBackupCompressedBytes   = 32 << 30
	maxBackupDecompressedBytes = 64 << 30
	maxSQLRestoreBytes         = 2 << 30
	maxSQLStatementBytes       = 16 << 20
	maxBackupTables            = 10_000
	maxBackupObjects           = 100_000
	maxBackupColumnsPerTable   = 10_000
	maxBackupRows              = 100_000_000
	maxImportRows              = 1_000_000
	maxImportColumns           = 10_000
)
