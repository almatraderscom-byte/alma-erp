package com.almatraders.erp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AlmaPushChannels.ensureCreated(this);
        super.onCreate(savedInstanceState);
    }
}
