package com.fluxmeridian.brain3companion;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BridgeHolder.INSTANCE.attach(getBridge());
    }

    @Override
    protected void onDestroy() {
        BridgeHolder.INSTANCE.detach(getBridge());
        super.onDestroy();
    }
}
