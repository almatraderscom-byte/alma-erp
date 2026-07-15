//
//  AlmaFileShare.kt
//  ALMA ERP — native CSV export + share, replacing the "CSV/Excel export — ওয়েবে"
//  escapes (payroll, inventory, invoices). The web builds these files client-side, so
//  there is no server endpoint to hit — instead we build the CSV natively from the
//  rows the screen already loaded and hand it to the Android share sheet (ACTION_SEND
//  via the manifest FileProvider). Opens in Excel/Sheets/email. No web page.
//

package com.almatraders.erp.pages

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/** RFC-4180 field escaping: quote if it contains comma/quote/newline; double quotes. */
private fun csvField(value: String): String {
    val needsQuote = value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r')
    val escaped = value.replace("\"", "\"\"")
    return if (needsQuote) "\"$escaped\"" else escaped
}

private fun buildCsv(headers: List<String>, rows: List<List<String>>): String {
    val sb = StringBuilder()
    sb.append('﻿') // UTF-8 BOM so Excel reads Bangla correctly
    sb.append(headers.joinToString(",") { csvField(it) }).append("\r\n")
    for (row in rows) sb.append(row.joinToString(",") { csvField(it) }).append("\r\n")
    return sb.toString()
}

/** Write a CSV built from [headers]/[rows] to cache and open the native share sheet. */
fun shareCsv(context: Context, fileName: String, headers: List<String>, rows: List<List<String>>) {
    try {
        val safeName = if (fileName.endsWith(".csv")) fileName else "$fileName.csv"
        val file = File(context.cacheDir, safeName)
        file.writeText(buildCsv(headers, rows), Charsets.UTF_8)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/csv"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, safeName)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(
            Intent.createChooser(send, "Export / Share").apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) },
        )
    } catch (_: Exception) { }
}
